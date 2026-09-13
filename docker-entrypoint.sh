#!/bin/sh
# Two jobs from one image: run the server, or create the first admin.
#
# `create-admin` exists because a fresh volume has no accounts and registration
# is closed by default — so there must be a way in that does not require the
# very session it is trying to create. It reads the password from stdin, never
# from an argument, so it does not land in shell history or `docker inspect`.
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
  *)
    # Anything else is run verbatim, so `docker run IMAGE node -v` and the like
    # still work for debugging.
    exec "$@"
    ;;
esac
