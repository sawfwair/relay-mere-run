fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/sparkle.m");
        cc::Build::new()
            .file("src/sparkle.m")
            .flag("-fobjc-arc")
            .compile("node_sparkle");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
    tauri_build::build()
}
