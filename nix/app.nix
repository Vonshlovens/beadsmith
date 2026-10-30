# The app laid out as /app: the built server, production node_modules, and the
# few script files `node scripts/accounts.ts` imports (the Dockerfile's list;
# if the script's imports change, change this list. image-smoke runs it offline).
{ runCommand, callPackage, build, prodModules }:
let
  src = callPackage ./source.nix { };
in
runCommand "beadsmith-app" { } ''
  app=$out/app
  mkdir -p $app/scripts $app/src/lib/server/auth $app/src/lib/server/state
  cp ${src}/package.json ${src}/server.js $app/
  cp -r ${build} $app/build
  cp -a ${prodModules} $app/node_modules
  cp ${src}/scripts/accounts.ts $app/scripts/
  cp ${src}/src/lib/server/auth/{recovery,password-policy,roles}.ts $app/src/lib/server/auth/
  cp ${src}/src/lib/server/state/dir.ts $app/src/lib/server/state/
''
