FROM node:22-bookworm-slim
ARG TARGETARCH
ARG CODE_SERVER_VERSION=4.121.0
ARG CODE_SERVER_SHA256_AMD64=3860893f15376e5f984492c5c92e87c51975d67e3902410f422823d9f60e06af
ARG CODE_SERVER_SHA256_ARM64=de5101a3c1f86b3853431d6920dcf4daaca879f613dec9139496099e31baa569
COPY package.json package-lock.json /opt/devcloud-tools/
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates tmux bash procps python3 python3-pip openjdk-17-jdk-headless maven && rm -rf /var/lib/apt/lists/* \
 && cd /opt/devcloud-tools \
 && npm ci --omit=dev --no-audit --no-fund \
 && ln -s /opt/devcloud-tools/node_modules/.bin/pnpm /usr/local/bin/pnpm \
 && ln -s /opt/devcloud-tools/node_modules/.bin/codex /usr/local/bin/codex \
 && ln -s /opt/devcloud-tools/node_modules/.bin/claude /usr/local/bin/claude \
 && case "${TARGETARCH}" in \
      amd64) code_server_arch=amd64; code_server_sha256="${CODE_SERVER_SHA256_AMD64}" ;; \
      arm64) code_server_arch=arm64; code_server_sha256="${CODE_SERVER_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && code_server_archive="code-server-${CODE_SERVER_VERSION}-linux-${code_server_arch}.tar.gz" \
 && curl --fail --location --retry 3 --output "/tmp/${code_server_archive}" \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${code_server_archive}" \
 && echo "${code_server_sha256}  /tmp/${code_server_archive}" | sha256sum --check --strict \
 && mkdir -p "/opt/code-server-${CODE_SERVER_VERSION}" \
 && tar -xzf "/tmp/${code_server_archive}" --strip-components=1 -C "/opt/code-server-${CODE_SERVER_VERSION}" \
 && ln -s "/opt/code-server-${CODE_SERVER_VERSION}/bin/code-server" /usr/local/bin/code-server \
 && rm -f "/tmp/${code_server_archive}"
ENV DISABLE_AUTOUPDATER=1
RUN useradd -m -u 10001 -s /bin/bash devcloud && mkdir -p /workspace/repository /workspace/worktrees && chown -R devcloud:devcloud /workspace
USER devcloud
WORKDIR /workspace/repository
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["test", "-x", "/usr/local/bin/code-server"]
CMD ["sleep","infinity"]
