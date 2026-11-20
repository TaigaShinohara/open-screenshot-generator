# GLib 0.18 security backport

This is the crates.io `glib` 0.18.5 source, originally built from
gtk-rs/gtk-rs-core commit `42b9caf98e03ded086362d9653ca58fe94dc8658`.
It retains the upstream MIT license text and version; the license's trailing
blank line is omitted. Registry cache marker and
checksum files are omitted because Cargo resolves this copy as a path patch.

The only Rust source change is the two-line fix in
`src/variant_iter.rs`, backported from
[gtk-rs-core #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343)
for [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
The pointer passed to `g_variant_get_child` is mutable and passed as `&mut p`.
This preserves the compiler's knowledge of the C function's out-argument.

Tauri's GTK 3 dependencies require GLib 0.18. Upgrading only GLib to 0.20
would break the shared GTK types. The path patch preserves the 0.18 API
while fixing the unsafe write through an immutable reference. It is a
verified backport, not an assertion that upstream 0.18.5 is unaffected.

Run the optimized public API regression with:

```sh
cargo test --manifest-path tests/regressions/glib-variant/Cargo.toml --locked --release
```

This requires the GLib development library and pkg-config. The CI workflow
runs it on Linux. Remove this patch when the owning GTK/Tauri dependency
supports an upstream GLib version containing the fix.
