import csrfProtection from '@fastify/csrf-protection';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginInputSchema, PasswordResetRequestSchema, PasswordResetConfirmSchema, type Actor, type Role } from '@medam/shared';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../errors.js';
import { audit, withTransaction } from '../../db/index.js';
import { verifyPassword } from './passwords.js';
import { completePasswordReset, hashToken, limitAuth, loadSession, newToken, normalizeLogin, toActor, userWithWarehouseSql, type UserRow } from './service.js';

declare module 'fastify' {
  interface FastifyRequest { actor: Actor | null; sessionTokenHash: string | null }
}
export function requireAuth(request: FastifyRequest): Actor {
  if(!request.actor) throw new ApiError(401,'SESSION_REQUIRED','Zaloguj się ponownie.');
  return request.actor;
}
export function requireRole(request: FastifyRequest, roles: readonly Role[]): Actor {
  const actor=requireAuth(request);
  if(!roles.includes(actor.role)) throw new ApiError(403,'FORBIDDEN','Brak uprawnień do tej operacji.');
  return actor;
}

/** A fresh login is required for privileged account changes and manual reconciliation. */
export async function requireRecentAuth(request: FastifyRequest, ctx: AppContext): Promise<void> {
  const actor = requireAuth(request);
  if (!request.sessionTokenHash) throw new ApiError(401, 'SESSION_REQUIRED', 'Zaloguj się ponownie.');
  const session = await ctx.db.query(`SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2
    AND revoked_at IS NULL AND expires_at>now() AND created_at>now()-interval '15 minutes'`, [request.sessionTokenHash, actor.id]);
  if (!session.rowCount) throw new ApiError(403, 'ADMIN_REAUTH_REQUIRED', 'Ta operacja wymaga ponownego zalogowania.');
}

export async function registerAuth(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const {db,config}=ctx;
  const sessionCookie=config.cookieSecure?'__Host-medam_session':'medam_session';
  const csrfCookie=config.cookieSecure?'__Host-medam_csrf':'medam_csrf';
  const cookieOpts={path:'/',httpOnly:true,secure:config.cookieSecure,sameSite:'lax' as const};
  app.decorateRequest('actor',null);
  app.decorateRequest('sessionTokenHash',null);
  await app.register(csrfProtection,{
    cookieKey:csrfCookie,cookieOpts:{...cookieOpts,signed:true},
    getToken:request=>typeof request.headers['x-csrf-token']==='string'?request.headers['x-csrf-token']:'',
    getUserInfo:request=>request.sessionTokenHash??'preauth',csrfOpts:{hmacKey:config.sessionSecret},
    logLevel:'warn',
  });
  const publicPaths=new Set(['/api/auth/csrf','/api/auth/login','/api/auth/password-reset/request','/api/auth/password-reset/confirm']);
  app.addHook('onRequest',(request,reply,done)=>{
    void (async()=>{
      const path=request.url.split('?')[0]??'';
      if(!path.startsWith('/api/')) return false;
      const token=request.cookies[sessionCookie];
      if(token){
        request.actor=await loadSession(db,token,config);
        if(request.actor) request.sessionTokenHash=hashToken(token);
        else reply.clearCookie(sessionCookie,cookieOpts);
      }
      if(!publicPaths.has(path)){
        const actor=requireAuth(request);
        if(actor.role==='medic'&&!actor.warehouse&&path!=='/api/auth/logout')
          throw new ApiError(403,'WAREHOUSE_ASSIGNMENT_REQUIRED','Brak aktywnego przypisania magazynu. Skontaktuj się z administratorem.');
      }
      if(!['GET','HEAD','OPTIONS'].includes(request.method)){
        if(request.headers.origin!==config.appOrigin){
          await audit(db,{actorId:request.actor?.id??null,action:'auth.origin_rejected',outcome:'denied'});
          throw new ApiError(403,'CSRF_INVALID','Nieprawidłowe źródło żądania. Odśwież aplikację.');
        }
        return true;
      }
      return false;
    })().then(needsCsrf=>needsCsrf?app.csrfProtection(request,reply,done):done()).catch(done);
  });
  app.addHook('onError',(request,_reply,error,done)=>{
    const code=(error as {code?:string}).code;
    if(code?.startsWith('FST_CSRF_')){
      void audit(db,{actorId:request.actor?.id??null,action:'auth.csrf_rejected',outcome:'denied'}).then(()=>done(),()=>done());
    }else done();
  });

  app.get('/api/auth/csrf',async(request,reply)=>{
    await limitAuth(db,config,'csrf',request.ip,60,60);
    return {csrfToken:reply.generateCsrf({userInfo:request.sessionTokenHash??'preauth'})};
  });
  app.post('/api/auth/login',async(request,reply)=>{
    const input=LoginInputSchema.parse(request.body);
    const login=normalizeLogin(input.login);
    try{
      await limitAuth(db,config,'login-ip',request.ip,30,900);
      await limitAuth(db,config,'login-account',login,5,900);
    }catch(error){reply.header('Retry-After','900');await audit(db,{action:'auth.login_rate_limited',outcome:'denied'});throw error;}
    const result=await db.query<UserRow>(`${userWithWarehouseSql} WHERE u.login=$1`,[login]);
    const row=result.rows[0];
    const passwordMatches=await verifyPassword(row?.password_hash??null,input.password);
    if(!row||!row.active||!passwordMatches){
      await audit(db,{action:'auth.login',outcome:'denied'});
      throw new ApiError(401,'LOGIN_FAILED','Nieprawidłowy login lub hasło.');
    }
    const token=newToken(), tokenHash=hashToken(token);
    const user = await withTransaction(db,async client=>{
      // Hash verification is intentionally outside the transaction. Recheck the exact credential
      // under a user-row lock so a concurrent reset cannot create a session with an old password.
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [row.id]);
      const freshResult = await client.query<UserRow>(`${userWithWarehouseSql} WHERE u.id=$1`, [row.id]);
      const fresh = freshResult.rows[0];
      if (!fresh || !fresh.active || fresh.password_hash !== row.password_hash || fresh.password_version !== row.password_version) {
        throw new ApiError(401, 'LOGIN_FAILED', 'Nieprawidłowy login lub hasło.');
      }
      const actor = toActor(fresh);
      if(actor.role==='medic'&&!actor.warehouse) throw new ApiError(403,'WAREHOUSE_ASSIGNMENT_REQUIRED','Brak aktywnego przypisania magazynu. Skontaktuj się z administratorem.');
      if(request.sessionTokenHash) await client.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[request.sessionTokenHash]);
      await client.query(`INSERT INTO sessions(token_hash,user_id,password_version,expires_at)
        VALUES($1,$2,$3,now()+($4::integer*interval '1 hour'))`,[tokenHash,fresh.id,fresh.password_version,config.sessionMaxHours]);
      await audit(client,{actorId:row.id,action:'auth.login',outcome:'success'});
      return actor;
    });
    reply.setCookie(sessionCookie,token,{...cookieOpts,maxAge:config.sessionMaxHours*3600});
    return {user,csrfToken:reply.generateCsrf({userInfo:tokenHash})};
  });
  app.get('/api/me',async(request,reply)=>({user:requireAuth(request),csrfToken:reply.generateCsrf({userInfo:request.sessionTokenHash??'preauth'})}));
  app.post('/api/auth/logout',async(request,reply)=>{
    const actor=requireAuth(request);
    await withTransaction(db,async client=>{
      await client.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[request.sessionTokenHash]);
      await audit(client,{actorId:actor.id,action:'auth.logout',outcome:'success'});
    });
    reply.clearCookie(sessionCookie,cookieOpts).clearCookie(csrfCookie,cookieOpts);
    return reply.code(204).send();
  });
  app.post('/api/auth/password-reset/request',async(request,reply)=>{
    const input=PasswordResetRequestSchema.parse(request.body);
    await limitAuth(db,config,'reset-ip',request.ip,10,3600);
    await limitAuth(db,config,'reset-account',normalizeLogin(input.login),3,3600);
    await audit(db,{action:'auth.password_reset_requested',outcome:'accepted'});
    return reply.code(202).send({message:'Jeśli konto istnieje, skontaktuj się z administratorem w celu bezpiecznego resetu hasła.'});
  });
  app.post('/api/auth/password-reset/confirm',async(request,reply)=>{
    const input=PasswordResetConfirmSchema.parse(request.body);
    await limitAuth(db,config,'reset-confirm-ip',request.ip,10,3600);
    await completePasswordReset(db,input.token,input.newPassword);
    reply.clearCookie(sessionCookie,cookieOpts).clearCookie(csrfCookie,cookieOpts);
    return reply.code(204).send();
  });
}
