FROM node:22-bookworm-slim
ARG CODE_SERVER_VERSION=4.99.4
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates tmux bash procps python3 python3-pip openjdk-17-jdk-headless maven && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm \
 && curl -fsSL https://code-server.dev/install.sh | sh -s -- --version ${CODE_SERVER_VERSION}
RUN useradd -m -u 10001 -s /bin/bash devcloud && mkdir -p /workspace/repository /workspace/worktrees && chown -R devcloud:devcloud /workspace
USER devcloud
WORKDIR /workspace/repository
CMD ["sleep","infinity"]
