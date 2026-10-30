# The OCI image, from the same app derivation the checks use; no Dockerfile.
# Mirrors the Dockerfile's runtime stage: Node, /app, user `node` (1000),
# 0.0.0.0:4321, no pnpm and no registry access at start. Dolt is not in it.
{ dockerTools, writeTextDir, beadsmith-nodejs-slim, cacert, bashInteractive, coreutils, app }:
dockerTools.buildLayeredImage {
  name = "beadsmith";
  tag = "nix";
  contents = [
    app
    beadsmith-nodejs-slim
    cacert
    bashInteractive
    coreutils
    (writeTextDir "etc/passwd" ''
      root:x:0:0:root:/root:/bin/bash
      node:x:1000:1000:node:/home/node:/bin/bash
    '')
    (writeTextDir "etc/group" ''
      root:x:0:
      node:x:1000:
    '')
  ];
  extraCommands = ''
    mkdir -p tmp home/node
    chmod 1777 tmp
  '';
  fakeRootCommands = ''
    chown 1000:1000 home/node
  '';
  config = {
    Cmd = [ "node" "server.js" ];
    WorkingDir = "/app";
    User = "node";
    ExposedPorts."4321/tcp" = { };
    Env = [
      "PATH=/bin"
      "NODE_ENV=production"
      "HOST=0.0.0.0"
      "PORT=4321"
      "BODY_SIZE_LIMIT=64K"
      "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
  };
}
