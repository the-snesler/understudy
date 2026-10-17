import { tryGetContext } from 'hono/context-storage';
import { raw } from 'hono/html';
import type { Child } from 'hono/jsx';
import type { PauseInfo } from '../core/controls.js';
import type { InstanceHealth } from '../core/plugin.js';
import { ICON_INLINE } from './icon.js';
import { Icon } from './icons.js';

declare module 'hono' {
  interface ContextVariableMap { pauseInfo: PauseInfo | undefined; hasControls: boolean }
}

export function Layout(props: { title: string; children: Child; bare?: boolean; section?: string }) {
  const context = tryGetContext();
  const signedIn = context?.get('signedIn');
  const section = props.section ?? (props.title === 'Log' ? 'log' : props.title === 'Settings' || props.title === 'Hub rules' ? 'settings' : props.title === 'Calendar' ? 'calendar' : 'overview');
  return <>{raw('<!DOCTYPE html>')}<html lang="en"><head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{`${props.title} · Understudy`}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="stylesheet" href="/assets/app.css" /><script src="/static/htmx.min.js" defer></script><script src="/assets/sortable.min.js" defer></script><script src="/assets/ui.js" defer></script>
  </head><body class={props.bare ? 'bare-layout' : ''}>
    <aside class="sidebar"><a class="brand" href="/">{raw(ICON_INLINE)}<span>Understudy</span></a>
      {!props.bare && <><nav aria-label="Main navigation">{[['overview', '/', 'Overview'], ['calendar', '/calendar', 'Calendar'], ['log', '/log', 'Log'], ['settings', '/settings', 'Settings']].map(([key, href, label]) => <a href={href} class={`nav-item ${section === key ? 'active' : ''}`} aria-current={section === key ? 'page' : undefined}><Icon name={key!} /><span>{label}</span></a>)}</nav><div class="mobile-publishing" hx-get="/partials/publishing" hx-trigger="every 3s" hx-swap="innerHTML"><PublishingCard pause={context?.get('pauseInfo')} available={!!context?.get('hasControls')} /></div>
        <div class="sidebar-bottom"><div hx-get="/partials/publishing" hx-trigger="every 3s" hx-swap="innerHTML"><PublishingCard pause={context?.get('pauseInfo') as PauseInfo | undefined} available={!!context?.get('hasControls')} /></div>
          {signedIn && <form method="post" action="/logout" class="logout"><button class="btn text"><Icon name="logout" size={16} />Log out</button></form>}</div></>}
    </aside><main class="main">{props.children}</main>
  </body></html></>;
}
export function PublishingCard({ pause, available }: { pause?: PauseInfo; available?: boolean }) {
  return <div class={`card publishing-card ${pause?.paused ? 'paused' : ''}`}><strong><span class={`dot ${pause?.paused ? 'h-warning' : 'h-ok'}`}></span>{pause?.paused ? 'Publishing paused' : 'Publishing'}</strong><p class="muted small">{pause?.paused ? pause.until ? `Resumes ${new Date(pause.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'Paused until you resume.' : 'Your activity flows to enabled outputs.'}</p>{available && (pause?.paused ? <form action="/resume" method="post"><button class="btn w-full"><Icon name="play" size={16} />Resume publishing</button></form> : <><form action="/pause" method="post"><button class="btn w-full" name="minutes" value="60"><Icon name="pause" size={16} />Pause for 1 hour</button></form><details class="pause-options"><summary>Other durations</summary><form action="/pause" method="post" class="actions">{[['30', '30 minutes'], ['240', '4 hours'], ['', 'Until I resume']].map(([value, label]) => <button class="btn small" name="minutes" value={value}>{label}</button>)}</form></details></>)}</div>;
}
export function LoginPage(props: { next?: string; error?: string }) {
  return <Layout title="Sign in" bare><form class="card login" method="post" action="/login"><h1>Welcome to Understudy</h1><p class="muted">Sign in to manage your activity.</p>{props.error && <Notice kind="error">{props.error}</Notice>}{props.next && <input type="hidden" name="next" value={props.next} />}<label>Password<input type="password" name="password" autocomplete="current-password" required autofocus /></label><button class="btn primary w-full">Sign in</button></form></Layout>;
}
export function Health(props: { health: InstanceHealth; message?: string; pill?: boolean }) { return <span class={`health health-${props.health} ${props.pill ? 'status-pill' : ''}`}><span class={`dot h-${props.health}`} title={props.health}></span>{props.message}</span>; }
export function Notice(props: { kind?: 'ok' | 'error'; children: Child }) { return <div role="status" class={`notice ${props.kind ?? ''}`}>{props.children}</div>; }
export function timeAgo(at: number, now = Date.now()): string { const s = Math.max(0, Math.floor((now - at) / 1000)); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; }
