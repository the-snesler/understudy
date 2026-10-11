import { hubRulesSchema, type HubRules } from '../core/hub.js';
import type { InstanceView, Registry } from '../core/registry.js';
import { pausedMediaLabels, RuleRow } from './components/rules.js';
import { SaveBar } from './components/save-bar.js';
import { SettingsFields } from './forms.js';
import { Icon } from './icons.js';

export { SaveBar } from './components/save-bar.js';

interface OutputRulesCardProps {
  registry: Pick<Registry, 'hubRules' | 'sources'>;
  view: Pick<InstanceView, 'config' | 'label'>;
  values?: Partial<HubRules>;
  error?: string;
}

export function OutputRulesCard({ registry, view, values, error }: OutputRulesCardProps) {
  const hubRules = registry.hubRules();
  const overrides = values ?? view.config.rules;
  const effectiveRules = { ...hubRules, ...overrides };
  const priority = registry.sources().map((source) => source.label).join(', ') || 'No sources yet';

  return (
    <section class="card hub-card settings-card">
      <div class="card-header">
        <div class="flex items-center gap-3">
          <span class="hub-icon"><Icon name="hub" size={18} /></span>
          <div>
            <h2>What to show</h2>
            <p class="small muted">
              {overrides ? 'Uses different rules for this output' : 'Uses the Hub’s rules'}
            </p>
          </div>
        </div>
        <a href="/settings/hub" class="small font-semibold">Edit Hub rules</a>
      </div>
      <div class="card-body">
        <RuleRow label="Priority" value={priority} inherited />
        <RuleRow
          label="Paused media"
          value={pausedMediaLabels[effectiveRules.paused]}
          inherited={overrides?.paused === undefined}
        />
        <RuleRow
          label="Quiet hours"
          value={effectiveRules.quietHours || 'Off'}
          inherited={overrides?.quietHours === undefined}
        />
        <RuleRow
          label="Time zone"
          value={effectiveRules.timeZone}
          inherited={overrides?.timeZone === undefined}
        />
        {error && <p class="field-error" role="alert">{error}</p>}
        <div class="mt-5 pt-5 border-t border-line">
          <label class="switch-row">
            <span class="font-semibold small">Use different rules for {view.label}</span>
            <span class="switch">
              <input type="checkbox" role="switch" name="rulesEnabled" checked={!!overrides} data-rules-toggle />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <p class="help">Override paused media or quiet hours for this output.</p>
          <div data-rules-fields hidden={!overrides}>
            <RulesFields rules={effectiveRules} />
          </div>
        </div>
      </div>
    </section>
  );
}

function RulesFields({ rules }: { rules: HubRules }) {
  const pausedOptions = [
    ['hide', 'Hide'],
    ['last', 'Show only when nothing is playing'],
    ['show', 'Show'],
  ];

  return (
    <div class="form-grid mt-4">
      <div class="field field-wide">
        <label for="rules-paused">Paused media</label>
        <select id="rules-paused" name="rules.paused">
          {pausedOptions.map(([value, label]) => (
            <option value={value} selected={rules.paused === value}>{label}</option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="rules-quiet">Quiet hours</label>
        <input id="rules-quiet" type="text" name="rules.quietHours" value={rules.quietHours} placeholder="23:00-07:00" />
      </div>
      <div class="field">
        <label for="rules-zone">Time zone</label>
        <input id="rules-zone" type="text" name="rules.timeZone" value={rules.timeZone} />
      </div>
    </div>
  );
}

interface HubSettingsProps {
  registry: Registry;
  errors?: Record<string, string>;
  values?: Record<string, unknown>;
}

export function HubSettings({ registry, errors, values }: HubSettingsProps) {
  return (
    <form class="settings-form" data-save-message="Rules apply to every output using the Hub." method="post" action="/settings/hub">
      <section class="card">
        <div class="flex items-center gap-3 mb-3">
          <span class="hub-icon"><Icon name="hub" size={19} /></span>
          <h2>Activity selection</h2>
        </div>
        <p class="muted small">
          The first active source wins. Drag sources on the <a href="/">Overview</a> to change their priority. Recency breaks ties.
        </p>
      </section>
      <SettingsFields schema={hubRulesSchema} values={values ?? registry.hubRules()} errors={errors} />
      <SaveBar message="Rules apply to every output using the Hub." button="Save rules" />
    </form>
  );
}
