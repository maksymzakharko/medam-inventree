#!/usr/bin/env bash
# Uruchomić na właściwym VPS po zakupie i weryfikacji klucza hosta.
# Wyłącznie odczyt, bez sudo, instalacji, restartów i modyfikacji konfiguracji.
set -u

section() { printf '\n## %s\n' "$1"; }
run() {
  if command -v "$1" >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
      timeout 20 "$@" || printf 'Niepełny odczyt lub brak uprawnień: %s\n' "$1"
    else
      "$@" || printf 'Niepełny odczyt lub brak uprawnień: %s\n' "$1"
    fi
  else
    printf 'Brak polecenia: %s\n' "$1"
  fi
}

section 'Czas i tożsamość hosta'
run date -u '+%Y-%m-%dT%H:%M:%SZ'
run hostname
run id
run uname -a
if [[ -r /etc/os-release ]]; then cat /etc/os-release; fi
run uptime
run timedatectl status

section 'Zasoby'
run nproc
run free -h
run df -hT
run df -i
run lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS

section 'Uruchomione usługi i porty'
run systemctl --failed --no-pager
run systemctl list-units --type=service --state=running --no-pager
run ss -lntup

section 'Docker — bez odczytu environment kontenerów'
run docker version
run docker compose version
run docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
run docker compose ls
run docker volume ls --format '{{.Name}}'
run docker system df

section 'Firewall — tylko jeżeli konto ma prawo odczytu'
run ufw status verbose
run nft list ruleset

section 'Koniec odczytu'
printf '%s\n' 'Brak odczytu reguł lub listy kontenerów nie oznacza ich braku.'
printf '%s\n' 'Osobno sprawdzić firewall OVH, DNS, konsolę rescue i bezpieczny backup konfiguracji.'
