import { Icon } from '../icons.js';

export const pausedMediaLabels = {
  hide: 'Hide',
  last: 'Show last',
  show: 'Show',
} as const;

interface RuleRowProps {
  icon?: string;
  label: string;
  value: string;
  inherited?: boolean;
}

export function RuleRow({ icon, label, value, inherited }: RuleRowProps) {
  return (
    <div class="rule-row">
      {icon && <Icon name={icon} size={17} />}
      <span>{label}</span>
      <strong>
        {value}
        {inherited !== undefined && (
          <span class="block text-xs font-normal muted mt-1">
            {inherited ? 'Inherited from Hub' : 'Output override'}
          </span>
        )}
      </strong>
    </div>
  );
}
