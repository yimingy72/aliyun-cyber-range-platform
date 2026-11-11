#!/usr/bin/env bash
set -euo pipefail
umask 077

base=$(cd -- "$(dirname -- "$0")" && pwd)
source "$base/settings.env"
: "${PUBLIC_IP:?}" "${CADDY_CONTAINER:?}" "${CERTBOT_IMAGE:?}"

exec 9>"$base/certbot.lock"
flock 9

if ! docker image inspect "$CERTBOT_IMAGE" >/dev/null 2>&1 && [[ -r "$base/certbot-image.tar.gz" ]]; then
    docker load --input "$base/certbot-image.tar.gz"
fi

certbot() {
    docker run --rm --pull never \
        -v "$base/letsencrypt:/etc/letsencrypt" \
        -v "$base/webroot:/var/www/acme" \
        -v "$base/logs:/var/log/letsencrypt" \
        "$CERTBOT_IMAGE" "$@" --non-interactive --required-profile shortlived
}

served_fingerprint() {
    # No SNI: verify the same IP-only certificate selection as external clients.
    timeout 8 openssl s_client -connect 127.0.0.1:443 -noservername </dev/null 2>/dev/null \
        | openssl x509 -noout -fingerprint -sha256
}

case "${1:-renew}" in
    issue|issue-dry-run)
        args=()
        [[ "$1" != issue-dry-run ]] || args+=(--dry-run)
        certbot certonly --cert-name "$PUBLIC_IP" --ip-address "$PUBLIC_IP" \
            --webroot -w /var/www/acme --agree-tos --register-unsafely-without-email "${args[@]}"
        exit
        ;;
    renew-dry-run)
        certbot renew --cert-name "$PUBLIC_IP" --no-random-sleep-on-renew --dry-run
        exit
        ;;
    renew|renew-force)
        args=()
        [[ "${1:-renew}" != renew-force ]] || args+=(--force-renewal)
        renewal_status=0
        certbot renew --cert-name "$PUBLIC_IP" --no-random-sleep-on-renew "${args[@]}" || renewal_status=$?
        ;;
    *) echo 'Usage: manage-ip-certificate.sh [issue|issue-dry-run|renew|renew-dry-run|renew-force]' >&2; exit 2 ;;
esac

lineage="$base/letsencrypt/live/$PUBLIC_IP"
openssl verify -purpose sslserver -verify_ip "$PUBLIC_IP" \
    -untrusted "$lineage/chain.pem" "$lineage/cert.pem" >/dev/null
openssl x509 -in "$lineage/cert.pem" -noout -checkend 43200
expected=$(openssl x509 -in "$lineage/cert.pem" -noout -fingerprint -sha256)

if [[ "$(served_fingerprint || true)" != "$expected" ]]; then
    docker exec "$CADDY_CONTAINER" caddy reload --force \
        --config /etc/caddy-ip-tls/Caddyfile --adapter caddyfile
    [[ "$(served_fingerprint)" == "$expected" ]]
    echo 'Caddy is serving the updated certificate.'
else
    echo 'Caddy is already serving the current certificate.'
fi
exit "$renewal_status"
