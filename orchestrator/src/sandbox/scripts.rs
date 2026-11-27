//! Shell scripts the providers run, byte-compatible with the ones the former TypeScript worker wrote.
//! orchestrator/tests/sandbox_scripts.rs compares them with its output (fixtures/scripts.json).

/// Shell-quotes one argument (`q` in TypeScript).
pub fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Sandbox homes end up unquoted in shell commands, so they are limited to these characters.
pub fn safe_path(p: &str) -> bool {
    p.starts_with('/') && p.len() > 1 && p.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c))
}

/// Size of a sandbox's own virtual screen on an SSH host; the tester's browser viewport is 1440x900. A run
/// that tests larger screen sizes writes a bigger one (`WxHx24`) to `.gespann-screen` first.
const SCREEN: &str = "1440x900x24";

/// Sets up a sandbox's shell: `HOME` is the sandbox, and Codex's sign-in and global npm installs live
/// below it, so a sandbox works without root and projects sharing a machine stay apart. The machine
/// user's own `~/.codex/config.toml` is linked into each sandbox. A sandbox with its own screen
/// (`.gespann-display`) gets that `DISPLAY`.
pub fn prelude(home: &str) -> String {
    let h = q(home);
    [
        r#"_gespann_user_home="$HOME""#.to_string(),
        format!("export HOME={h} CODEX_HOME={h}/.codex NPM_CONFIG_PREFIX={h}/.npm-global"),
        r#"export PATH="$NPM_CONFIG_PREFIX/bin:$PATH""#.to_string(),
        r#"if [ "$_gespann_user_home" != "$HOME" ] && [ -f "$_gespann_user_home/.codex/config.toml" ] && [ ! -e "$CODEX_HOME/config.toml" ]; then mkdir -p "$CODEX_HOME" && ln -s "$_gespann_user_home/.codex/config.toml" "$CODEX_HOME/config.toml"; fi"#.to_string(),
        "unset _gespann_user_home".to_string(),
        // A sandbox with its own screen (SSH hosts: see Ssh::screen) uses it instead of the machine's.
        r#"if [ -s "$HOME/.gespann-display" ]; then export DISPLAY="$(cat "$HOME/.gespann-display")"; fi"#.to_string(),
        r#"cd "$HOME" || exit 1"#.to_string(),
    ]
    .join("\n")
}

/// Starts ffmpeg on the sandbox's screen in the background, writing an mp4 to `file`. Few frames and a
/// high CRF: the screen mostly stands still, so a long test stays a small file. A keyframe every 5 s
/// (`-g 25` at 5 fps): x264's default of one per 250 frames is one per 50 s, and a seek in the player
/// decodes from the keyframe before it, so scrubbing a 2000-pixel recording froze the run page.
pub fn record_script(file: &str, own_screen: bool) -> String {
    let f = q(file);
    let mut lines = vec![
        r#"p="$HOME/.gespann-recording""#.to_string(),
        r#"command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is not installed on the sandbox's machine" >&2; exit 1; }"#.to_string(),
        r#"[ -n "${DISPLAY:-}" ] || { echo "the sandbox has no screen (DISPLAY is not set)" >&2; exit 1; }"#.to_string(),
    ];
    // On a shared machine the fallback DISPLAY may show other jobs' windows: record only the sandbox's own screen.
    if own_screen {
        lines.push(r#"[ -s "$HOME/.gespann-display" ] || { echo "the sandbox has no screen of its own (Xvfb is not installed on the machine)" >&2; exit 1; }"#.to_string());
    }
    lines.push(stop_record_script());
    lines.push(format!(r#"mkdir -p "$(dirname {f})"; rm -f {f}"#));
    lines.push(r#"s="$(command -v setsid || true)""#.to_string());
    lines.push(format!(
        r#"nohup $s ffmpeg -nostdin -loglevel error -y -f x11grab -draw_mouse 1 -framerate 5 -i "$DISPLAY" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset veryfast -crf 32 -g 25 -pix_fmt yuv420p {f} > "$p.log" 2>&1 < /dev/null &"#
    ));
    lines.push(r#"echo $! > "$p.pid""#.to_string());
    // ffmpeg fails at once when it cannot open the screen; give it that moment.
    lines.push("sleep 1".to_string());
    lines.push(r#"kill -0 "$(cat "$p.pid")" 2>/dev/null || { echo "ffmpeg stopped right away: $(tail -c 300 "$p.log")" >&2; rm -f "$p.pid"; exit 1; }"#.to_string());
    lines.join("\n")
}

/// Ends the recording with SIGTERM, on which ffmpeg writes the mp4's index, and waits up to 30 s for it.
/// Not SIGINT: a shell starts background commands with SIGINT ignored.
pub fn stop_record_script() -> String {
    [
        r#"p="$HOME/.gespann-recording""#,
        r#"r="$(cat "$p.pid" 2>/dev/null)""#,
        r#"if [ -n "$r" ] && kill -TERM "$r" 2>/dev/null; then i=0; while kill -0 "$r" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL "$r" 2>/dev/null; fi"#,
        r#"rm -f "$p.pid""#,
        "true",
    ]
    .join("\n")
}

/// Readies a finished recording for the run page: the video starts at the first frame that is not black
/// (the screen stays black until the tester opens its browser), has a keyframe every 5 s, and the index
/// goes to the front. Always re-encoded: hosted sandboxes record with their own recorder, whose
/// keyframes are 50 s apart, and a seek in the player decodes from the keyframe before it, so scrubbing
/// a 2000-pixel recording froze the run page. Three minutes take about 4 s on two cores.
pub fn finish_recording_script(file: &str) -> String {
    let f = q(file);
    let tmp = q(&format!("{file}.tmp.mp4"));
    [
        format!("test -s {f} || exit 0"),
        // Black means the empty screen: nearly every pixel at zero. A dark page is not black and stays.
        format!(r#"o="$(ffmpeg -nostdin -hide_banner -i {f} -vf blackdetect=d=1:pix_th=0.02:pic_th=0.999 -an -f null - 2>&1)""#),
        r#"b="$(printf '%s\n' "$o" | grep -o 'black_start:0 black_end:[0-9.]*' | head -n 1 | cut -d: -f3)""#.to_string(),
        r#"d="$(printf '%s\n' "$o" | sed -n 's/.*Duration: \([0-9]*\):\([0-9]*\):\([0-9.]*\).*/\1 \2 \3/p' | head -n 1 | awk '{ print $1 * 3600 + $2 * 60 + $3 }')""#.to_string(),
        // A video that is black throughout keeps its start.
        r#"s=0; if [ -n "$b" ] && [ -n "$d" ] && awk -v b="$b" -v d="$d" 'BEGIN { exit !(b < d - 0.5) }'; then s="$b"; fi"#.to_string(),
        // Keyframes by time, not frame count: the hosted recorder's frame rate is not ours. veryfast,
        // because ultrafast makes the file about twice as large at that spacing.
        format!(r#"{{ ffmpeg -nostdin -loglevel error -y -ss "$s" -i {f} -an -c:v libx264 -preset veryfast -crf 32 -force_key_frames 'expr:gte(t,n_forced*5)' -pix_fmt yuv420p -movflags +faststart {tmp} && test -s {tmp}; }} ||"#),
        format!("  ffmpeg -nostdin -loglevel error -y -i {f} -c copy -movflags +faststart {tmp} ||"),
        // A failed ffmpeg may leave half a file: keep the original recording then.
        format!("  {{ rm -f {tmp}; exit 0; }}"),
        format!("test -s {tmp} && mv {tmp} {f}"),
        format!("rm -f {tmp}"),
    ]
    .join("\n")
}

/// Cuts the part of a finished recording that shows the PR's change to `out`: `length` seconds from
/// `start`, encoded like `finish_recording_script`. Run before that script, which trims the start of
/// `file`. Writes nothing when the part is nearly the whole recording or the cut fails.
pub fn clip_recording_script(file: &str, out: &str, start: f64, length: f64) -> String {
    let (f, o) = (q(file), q(out));
    let tmp = q(&format!("{out}.tmp.mp4"));
    [
        format!("rm -f {o} {tmp}"),
        format!("test -s {f} || exit 0"),
        format!(r#"d="$(ffmpeg -nostdin -hide_banner -i {f} 2>&1 | sed -n 's/.*Duration: \([0-9]*\):\([0-9]*\):\([0-9.]*\).*/\1 \2 \3/p' | head -n 1 | awk '{{ print $1 * 3600 + $2 * 60 + $3 }}')""#),
        // A part of 90 % or more of the recording is no shorter video worth a second file.
        format!(r#"[ -n "$d" ] && awk -v s={start} -v l={length} -v d="$d" 'BEGIN {{ exit !(s < d && l < 0.9 * d) }}' || exit 0"#),
        format!(r#"ffmpeg -nostdin -loglevel error -y -ss {start} -i {f} -t {length} -an -c:v libx264 -preset veryfast -crf 32 -force_key_frames 'expr:gte(t,n_forced*5)' -pix_fmt yuv420p -movflags +faststart {tmp} && test -s {tmp} && mv {tmp} {o}"#),
        format!("rm -f {tmp}"),
        "true".to_string(),
    ]
    .join("\n")
}

/// Starts a virtual screen for the sandbox at `dir` unless it has a live one, and writes its display to
/// `dir/.gespann-display` (which `prelude` exports). Does nothing on a machine without `DISPLAY` or Xvfb.
pub fn screen_script(dir: &str) -> String {
    let f = q(&format!("{dir}/.gespann-display"));
    let screen = q(&format!("{dir}/.gespann-screen"));
    [
        format!("f={f}"),
        r#"if [ -z "${DISPLAY:-}" ] || ! command -v Xvfb >/dev/null 2>&1; then rm -f "$f" "$f.pid" "$f.size"; exit 0; fi"#.to_string(),
        format!(r#"size="$(grep -xE '[0-9]{{3,4}}x[0-9]{{3,4}}x24' {screen} 2>/dev/null || echo {SCREEN})""#),
        r#"if [ -s "$f" ] && [ -s "$f.pid" ] && kill -0 "$(cat "$f.pid")" 2>/dev/null; then"#.to_string(),
        format!(r#"  [ "$(cat "$f.size" 2>/dev/null || echo {SCREEN})" = "$size" ] && exit 0"#),
        // Another size: this screen goes, the new one gets a new display number.
        r#"  kill "$(cat "$f.pid")" 2>/dev/null"#.to_string(),
        "fi".to_string(),
        r#"rm -f "$f" "$f.pid" "$f.n" "$f.size""#.to_string(),
        r#"s="$(command -v setsid || true)""#.to_string(),
        r#"nohup $s Xvfb -displayfd 3 -screen 0 "$size" -nolisten tcp 3> "$f.n" > /dev/null 2>&1 < /dev/null &"#.to_string(),
        r#"echo $! > "$f.pid""#.to_string(),
        r#"echo "$size" > "$f.size""#.to_string(),
        r#"i=0; while [ ! -s "$f.n" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done"#.to_string(),
        r#"n="$(tr -dc 0-9 < "$f.n")"; rm -f "$f.n""#.to_string(),
        r#"if [ -z "$n" ]; then kill "$(cat "$f.pid")" 2>/dev/null; rm -f "$f.pid"; echo "Xvfb did not start" >&2; exit 1; fi"#.to_string(),
        r#"echo ":$n" > "$f""#.to_string(),
    ]
    .join("\n")
}

/// Also forgets a bigger size a run asked for, so the next job starts with the default screen.
pub fn stop_screen_script(dir: &str) -> String {
    format!(
        r#"f={}; p="$(cat "$f.pid" 2>/dev/null)"; [ -n "$p" ] && kill "$p" 2>/dev/null; rm -f "$f" "$f.pid" "$f.size" {}; exit 0"#,
        q(&format!("{dir}/.gespann-display")),
        q(&format!("{dir}/.gespann-screen"))
    )
}

/// `installScript(ref, { core, url, bin })`: checks out gespann at `ref` and runs it by Node directly.
/// Checkout and `npm ci` run only when the ref moved since the last complete install or the lockfile changed.
pub fn install_script(git_ref: &str, core: &str, url: &str, bin: &str) -> String {
    let shown: String = git_ref.chars().filter(|c| c.is_ascii_alphanumeric() || "._/-".contains(*c)).collect();
    [
        format!("set -e; mkdir -p {}", q(&dirname(core))),
        format!("if [ ! -d {core}/.git ]; then git clone --quiet {} {core}; fi", q(url)),
        // The commit of the last complete install; removed before a checkout, written after npm ci succeeded.
        format!(r#"old="$(cat {core}/.gespann-installed 2>/dev/null || true)""#),
        format!("git -C {core} fetch --quiet origin {}", q(git_ref)),
        format!(r#"new="$(git -C {core} rev-parse FETCH_HEAD)""#),
        format!("bin={bin}"),
        format!(r#"if [ "$old" != "$new" ] || [ ! -x "$bin" ] || [ ! -d {core}/node_modules ]; then"#),
        format!(r#"  echo "gespann: installing gespann {shown} in the sandbox""#),
        format!("  rm -f {core}/.gespann-installed; git -C {core} checkout --quiet --force FETCH_HEAD"),
        format!(r#"  if [ -z "$old" ] || [ ! -d {core}/node_modules ] || ! git -C {core} diff --quiet "$old" "$new" -- package-lock.json 2>/dev/null; then (cd {core} && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent); fi"#),
        format!(r#"  mkdir -p "$(dirname "$bin")"; printf '#!/bin/sh\nexec node {core}/src/bin.ts "$@"\n' > "$bin"; chmod +x "$bin"; "$bin" --version; echo "$new" > {core}/.gespann-installed"#),
        "fi".to_string(),
    ]
    .join("\n")
}

/// Node's `path.posix.dirname`, which `installScript` uses (its algorithm, so odd slashes match too).
fn dirname(p: &str) -> String {
    let b = p.as_bytes();
    if b.is_empty() {
        return ".".into();
    }
    let rooted = b[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for i in (1..b.len()).rev() {
        if b[i] == b'/' {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => if rooted { "/" } else { "." }.into(),
        Some(1) if rooted => "//".into(),
        Some(e) => p[..e].to_string(),
    }
}

/// JavaScript's `\s`, which `words` splits on (Rust's `char::is_whitespace` differs at U+0085 and U+FEFF).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `words` from TypeScript: splits `SANDBOX_DOCKER_ARGS`-style text; single and double quotes group.
pub fn words(text: &str) -> anyhow::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    for ch in text.chars() {
        if let Some(qc) = quote {
            if ch == qc {
                quote = None;
            } else {
                cur.push(ch);
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
            has = true;
        } else if js_space(ch) {
            if has || !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            has = false;
        } else {
            cur.push(ch);
        }
    }
    if let Some(qc) = quote {
        anyhow::bail!("unclosed {qc} in: {text}");
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::dirname;

    #[test]
    fn dirname_as_node() {
        for (p, d) in [("/a/b/c", "/a/b"), ("/a/b/", "/a"), ("/a", "/"), ("/", "/"), ("a", "."), ("a/b", "a"), ("", "."), ("//a", "//"), ("/a//b", "/a/"), ("//", "/"), ("a//b/", "a/")] {
            assert_eq!(dirname(p), d, "{p}");
        }
    }
}
