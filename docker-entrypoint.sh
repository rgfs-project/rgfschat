#!/bin/sh
# Three jobs from one image: run the server, create the first admin, or reset a
# password.
#
# `create-admin` exists because a fresh volume has no accounts and registration
# is closed by default — so there must be a way in that does not require the
# very session it is trying to create. `reset-password` is the same hole from
# the other end: every other reset path needs an admin session, so a forgotten
# administrator password would otherwise mean editing JSON under /data by hand.
# Both read the password from stdin, never from an argument, so it does not land
# in shell history, in `ps`, or in `docker inspect`.
set -e

case "${1:-serve}" in
  serve)
    exec node dist/server/index.js
    ;;
  create-admin)
    shift
    # e.g.  docker run -i --rm -v chatui-data:/data IMAGE create-admin --username alice --admin
    exec node dist/server/scripts/createUser.js "$@"
    ;;
  reset-password)
    shift
    # e.g.  printf 'new-password\n' | docker run -i --rm -v chatui-data:/data IMAGE \
    #         reset-password --username alice
    # Existing sessions are revoked unless --keep-sessions is passed.
    exec node dist/server/scripts/setPassword.js "$@"
    ;;
  healthcheck)
    # What the image's HEALTHCHECK runs.
    #
    # It lives here, next to the command it is checking on, because it has to
    # agree with it about two things the operator chooses: the port, and
    # whether the listener is HTTP or HTTPS. A probe that hard-codes either one
    # reports a healthy server as unhealthy the moment the operator configures
    # TLS — which `docker-compose.yml` invites them to do.
    exec node -e '
      const tls = Boolean(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE);
      const lib = require(tls ? "node:https" : "node:http");
      const req = lib.request(
        {
          host: "127.0.0.1",
          port: process.env.PORT || 3001,
          path: "/api/health",
          timeout: 4000,
          // This is our own listener over the loopback, and the certificate on
          // it is very often self-signed or issued for the public hostname
          // rather than 127.0.0.1. Verifying it here would report on the
          // operator’s PKI instead of on whether the server is up.
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          process.exit(res.statusCode === 200 ? 0 : 1);
        }
      );
      req.on("error", () => process.exit(1));
      req.on("timeout", () => {
        req.destroy();
        process.exit(1);
      });
      req.end();
    '
    ;;
  *)
    # Anything else is run verbatim, so `docker run IMAGE node -v` and the like
    # still work for debugging.
    exec "$@"
    ;;
esac
