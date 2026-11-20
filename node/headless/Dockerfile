# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM rust:1.90.0-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc-x86-64-linux-gnu libc6-dev-amd64-cross \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add x86_64-unknown-linux-gnu
WORKDIR /build/node
COPY headless/Cargo.toml headless/Cargo.lock ./headless/
COPY headless/src ./headless/src
COPY src-tauri/src ./src-tauri/src
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc
RUN cargo build --locked --release --target x86_64-unknown-linux-gnu --manifest-path headless/Cargo.toml

FROM nvidia/cuda:12.9.1-cudnn-devel-ubuntu24.04@sha256:a2e1e2360c85298ac47ec2543b406ab1e8cec42e31ee47e4d32140ebc82e1067
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg libnuma1 libatomic1 libcurl4t64 util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 node \
    && mkdir -p /opt/mere-run /data/state /data/cache && chown -R node:node /data
# The runtime context contains only the pinned public release archive/checksum.
COPY --from=runtime mere-run-0.60.1-linux-x86_64-cuda.tar.gz /tmp/mere-run.tar.gz
RUN echo 'c465064323a63ddb06b6455f506f55bb6c7b629839105d329b362621807623f6  /tmp/mere-run.tar.gz' | sha256sum -c - \
    && tar --no-same-owner --strip-components=1 -xzf /tmp/mere-run.tar.gz -C /opt/mere-run \
    && rm /tmp/mere-run.tar.gz
COPY --from=build /build/node/headless/target/x86_64-unknown-linux-gnu/release/mere-run-node-headless /usr/local/bin/mere-run-node-headless
COPY --chmod=755 headless/container-entrypoint.sh /usr/local/bin/node-container-entrypoint
COPY --chmod=755 headless/gpu-preflight.sh /usr/local/bin/node-gpu-preflight
ENV MERERUN_BIN=/opt/mere-run/mere.run \
    MERERUN_MODELS_DIR=/data/cache/models \
    MERERUN_HUB_CACHE=/data/cache/hub \
    XDG_CACHE_HOME=/data/cache \
    HF_HOME=/data/cache/huggingface \
    MLX_CUDA_USE_CUDNN_SDPA=0
WORKDIR /home/node
HEALTHCHECK --interval=15s --timeout=3s CMD ["mere-run-node-headless", "health", "--state-dir", "/home/node/.local/share/mere-run-node"]
ENTRYPOINT ["/usr/local/bin/node-container-entrypoint"]
CMD ["run", "--state-dir", "/home/node/.local/share/mere-run-node"]
