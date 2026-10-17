import { raw } from 'hono/html';
import { Activity, ArrowDown, ArrowUp, Braces, Calendar, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Copy, Ellipsis, Film, Gamepad2, GitFork, GripVertical, LayoutDashboard, List, LogOut, MonitorPlay, Moon, Music, Pause, Play, Plus, RefreshCw, Rss, Send, Settings2, SlidersHorizontal, Trash2, Zap, type IconNode } from 'lucide';
import { siDiscord, siJellyfin, siLastdotfm, siPlex, siSteam, siTrakt } from 'simple-icons';

const icons: Record<string, IconNode> = { activity: Activity, 'arrow-down': ArrowDown, 'arrow-up': ArrowUp, braces: Braces, calendar: Calendar, 'calendar-clock': CalendarClock, 'chevron-left': ChevronLeft, 'chevron-right': ChevronRight, log: List, rss: Rss, check: Check, 'chevron-down': ChevronDown, clock: Clock, copy: Copy, ellipsis: Ellipsis, film: Film, gamepad: Gamepad2, hub: GitFork, grip: GripVertical, overview: LayoutDashboard, list: List, logout: LogOut, monitor: MonitorPlay, moon: Moon, music: Music, pause: Pause, play: Play, plus: Plus, restart: RefreshCw, send: Send, settings: Settings2, sliders: SlidersHorizontal, trash: Trash2, zap: Zap };
/** Render Lucide's trusted icon data on the server, without a browser icon runtime. */
export function Icon({ name, size = 20, class: className = '' }: { name: string; size?: number; class?: string }) {
  return <svg class={`ui-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{(icons[name] ?? Activity).map(([tag, attrs]) => raw(`<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${String(v)}"`).join(' ')} />`))}</svg>;
}
const brands = { tautulli: siPlex, discord: siDiscord, 'discord-status': siDiscord, steam: siSteam, jellyfin: siJellyfin, scrobbler: siLastdotfm, trakt: siTrakt };
const glyphs: Record<string, string> = { nintendo: 'gamepad', ical: 'calendar-clock', 'calendar-feed': 'rss', 'json-feed': 'braces' };
export function PluginIcon({ plugin, large = false }: { plugin: string; large?: boolean }) {
  const brand = brands[plugin as keyof typeof brands];
  return <span class={`plugin-icon plugin-${plugin} ${large ? 'large' : ''}`}>{brand ? <svg width="23" height="23" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={brand.path} /></svg> : <Icon name={glyphs[plugin] ?? 'monitor'} size={24} />}</span>;
}
