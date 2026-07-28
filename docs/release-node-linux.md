# Release Linux node packages

Linux node releases are architecture- and format-specific. Publish a Debian
package as the recommended install for Ubuntu and Debian, plus an AppImage as
the portable fallback:

```text
linux-x86_64 deb       -> /downloads/mere-run-node/linux/x86_64/deb/latest
linux-x86_64 AppImage  -> /downloads/mere-run-node/linux/x86_64/latest
linux-arm64 deb        -> /downloads/mere-run-node/linux/arm64/deb/latest
linux-arm64 AppImage   -> /downloads/mere-run-node/linux/arm64/latest
```

The arm64 routes also accept `aarch64`, and the x86_64 Debian route accepts
`amd64`, because Linux, Rust, and Debian use different names for the same CPU
architectures.

The Worker reads immutable artifacts and mutable promotion manifests from the
`IMAGES` R2 binding:

```text
bucket: <your-release-bucket>

AppImage key:    releases/mere-run-node/linux/<arch>/mere.run-node-<version>-<arch>.AppImage
AppImage latest: releases/mere-run-node/linux/<arch>/latest.json

deb key:         releases/mere-run-node/linux/<arch>/deb/mere.run-node-<version>-<deb-arch>.deb
deb latest:      releases/mere-run-node/linux/<arch>/deb/latest.json
```

Build and publish on each target architecture:

```sh
NODE_LINUX_R2_BUCKET='<your-release-bucket>' \
NODE_LINUX_DOWNLOAD_URL='https://relay.example.com/downloads/mere-run-node/linux/arm64/deb/latest' \
NODE_RELEASE_CATALOG_URL='https://relay.example.com/.well-known/mere-run-node/releases.json' \
  ./scripts/release-node-linux-deb.sh

NODE_LINUX_R2_BUCKET='<your-release-bucket>' \
NODE_LINUX_DOWNLOAD_URL='https://relay.example.com/downloads/mere-run-node/linux/arm64/latest' \
NODE_RELEASE_CATALOG_URL='https://relay.example.com/.well-known/mere-run-node/releases.json' \
  ./scripts/release-node-linux.sh
```

## Installation

Use the Debian package on Ubuntu and Debian. It installs the executable,
desktop entry, icons, and required GTK, WebKitGTK, HarfBuzz, and GLVND runtime
packages through `apt`:

```sh
VERSION="$(node -p "require('./node/package.json').version")"
sudo apt install "./mere.run-node-${VERSION}-arm64.deb"
mere.run-node
```

Use the AppImage on other distributions or when installation without root is
preferred:

```sh
VERSION="$(node -p "require('./node/package.json').version")"
chmod +x "mere.run-node-${VERSION}-arm64.AppImage"
"./mere.run-node-${VERSION}-arm64.AppImage"
```

Never launch the node itself with `sudo`.

Starting in `0.1.7`, a second launch reports the PID and command of the copy
that already owns the single-instance lock. If an older AppImage is still
running without a visible window, stop it and relaunch the installed package:

```sh
pkill -x mere.run-node
pkill -x mere-run-node
mere.run-node
```

Starting in `0.1.8`, `mere.run-node` is the canonical installed command so it
matches the `mere.run` CLI. The Debian package keeps `mere-run-node` as a
compatibility alias for existing scripts and shortcuts.

NVIDIA GB10/DGX Spark desktop images also need the NVIDIA EGL/GBM bridge for
WebKitGTK's accelerated renderer:

```sh
sudo apt install libnvidia-egl-gbm1
```

The application checks this before creating its webview. When the bridge is
missing it automatically selects WebKitGTK's compatible non-DMABUF renderer and
prints the installation command for restoring accelerated rendering.

The AppImage carries HarfBuzz and the hardware-neutral GLVND loader because
linuxdeploy excludes them from its default portability set. The Debian package
declares those same libraries as direct package dependencies. Vendor GPU drivers
always remain provided by the host.

## Publisher behavior

Both release scripts:

1. Refuse to run off Linux and detect `x86_64` or `arm64`.
2. Build the requested Tauri bundle on the target architecture.
3. Verify package metadata, payload, architecture, dependencies, and executable
   closure as appropriate for the format.
4. Upload the immutable artifact to remote R2.
5. Download it and byte-compare it with the local build.
6. Promote only that format's `latest.json` manifest.
7. Verify the public route headers, size, checksum, architecture, and format.
8. Confirm the public Node release catalog advertises the same artifact.

Publishing one format never replaces the other format's manifest. The
`mere.run` downloads page reads the catalog live and recommends `.deb` while
retaining the AppImage fallback.

Overrides remain available for externally built artifacts:

```sh
VERSION="$(node -p "require('./node/package.json').version")"
NODE_LINUX_ARCH=arm64 \
NODE_LINUX_ARTIFACT_PATH="node/src-tauri/target/release/bundle/deb/mere.run node_${VERSION}_arm64.deb" \
./scripts/release-node-linux-deb.sh

NODE_LINUX_ARCH=arm64 \
NODE_LINUX_ARTIFACT_PATH="node/src-tauri/target/release/bundle/appimage/mere.run node_${VERSION}_arm64.AppImage" \
./scripts/release-node-linux.sh
```

Do not publish a generic `linux/latest` artifact. CPU architecture and package
format are both part of the compatibility contract.
