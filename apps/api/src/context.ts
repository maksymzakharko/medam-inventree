import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { InventreeClient } from './integrations/inventree/client.js';

export interface AppContext { config: Config; db: Pool; inventory: InventreeClient }
