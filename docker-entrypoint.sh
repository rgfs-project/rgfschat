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
  *)
    # Anything else is run verbatim, so `docker run IMAGE node -v` and the like
    # still work for debugging.
    exec "$@"
    ;;
esac
