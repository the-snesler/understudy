import type { Child } from 'hono/jsx';
import type { InstanceHealth } from '../core/plugin.js';

const CSS = `
:root { color-scheme: light dark; --fg: #1d1f23; --muted: #6b7079; --bg: #f6f7f9; --card: #fff; --line: #dfe2e7;
  --accent: #5865f2; --ok: #1f9d55; --warn: #b7791f; --err: #d64545; --idle: #8a8f98; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e8eb; --muted: #9aa0a9; --bg: #15171a; --card: #1e2125; --line: #30343a; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; gap: 1.5rem; align-items: center; padding: .75rem 1.5rem; border-bottom: 1px solid var(--line); background: var(--card); }
header a { color: var(--fg); text-decoration: none; } header .brand { font-weight: 700; }
main { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; } h2 { font-size: 1.1rem; margin: 0 0 .75rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: .4rem .5rem; border-top: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: .85rem; border-top: 0; }
a { color: var(--accent); }
.muted { color: var(--muted); } .small { font-size: .85rem; }
.dot { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; margin-right: .4rem; vertical-align: middle; }
.h-ok { background: var(--ok); } .h-warning { background: var(--warn); } .h-error { background: var(--err); } .h-idle { background: var(--idle); } .h-setup { background: var(--accent); }
form.inline { display: inline; }
label { display: block; font-weight: 600; margin-top: .9rem; }
.help { color: var(--muted); font-size: .85rem; margin: .1rem 0 .3rem; font-weight: 400; }
input[type=text], input[type=number], input[type=password], input[type=url], select, textarea {
  width: 100%; padding: .45rem .6rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
textarea { min-height: 4.5rem; font-family: ui-monospace, monospace; }
input[type=checkbox] { margin-right: .4rem; }
button, .button { display: inline-block; padding: .45rem .9rem; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff;
  font: inherit; cursor: pointer; text-decoration: none; }
button.secondary, .button.secondary { background: transparent; color: var(--accent); }
button.danger { background: var(--err); border-color: var(--err); }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; align-items: center; }
.notice { padding: .6rem .9rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid var(--line); }
.notice.error { border-color: var(--err); } .notice.ok { border-color: var(--ok); }
code { font-family: ui-monospace, monospace; font-size: .9em; background: var(--bg); padding: .05rem .3rem; border-radius: 4px; word-break: break-all; }
pre { background: var(--bg); padding: .75rem; border-radius: 6px; overflow-x: auto; font-size: .85rem; }
.preview { display: flex; gap: .9rem; align-items: center; }
.preview img { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; }
.log td { font-family: ui-monospace, monospace; font-size: .8rem; white-space: pre-wrap; }
.lvl-warn { color: var(--warn); } .lvl-error { color: var(--err); }
.card.paused { border-color: var(--warn); }
button.small { padding: .2rem .6rem; font-size: .85rem; }
`;

export function Layout(props: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${props.title} · Understudy`}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <script src="/static/htmx.min.js" defer></script>
      </head>
      <body>
        <header>
          <a class="brand" href="/">
            Understudy
          </a>
          <a href="/">Dashboard</a>
          <a href="/log">Log</a>
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export function Health(props: { health: InstanceHealth; message?: string }) {
  return (
    <span>
      <span class={`dot h-${props.health}`} title={props.health}></span>
      {props.message}
    </span>
  );
}

export function Notice(props: { kind?: 'ok' | 'error'; children: Child }) {
  return <div class={`notice ${props.kind ?? ''}`}>{props.children}</div>;
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.round((now - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
