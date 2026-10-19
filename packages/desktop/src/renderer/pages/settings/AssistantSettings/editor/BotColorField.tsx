import { BOT_COLOR_PALETTE, isBotColor } from '@/common/types/agent/botColors';
import BotColorDot from '@/renderer/components/agent/BotColorDot';
import { Button, ColorPicker } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

type BotColorFieldProps = {
  /** The current `#rrggbb` color. */
  value: string;
  onChange: (color: string) => void;
};

/** The 12 palette swatches plus a custom picker. Picking only changes the editor draft; Save stores it. */
const BotColorField: React.FC<BotColorFieldProps> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const current = value.toLowerCase();
  const isCustom = isBotColor(value) && !BOT_COLOR_PALETTE.includes(current);
  const customLabel = t('settings.botColor.custom', { defaultValue: 'Custom' });

  return (
    <div className='flex flex-wrap items-center gap-8px' data-testid='bot-color-field'>
      {BOT_COLOR_PALETTE.map((color) => (
        <Button
          key={color}
          shape='circle'
          size='mini'
          aria-label={color}
          aria-pressed={color === current}
          onClick={() => onChange(color)}
          className={`!h-20px !w-20px !min-w-0 !border-none !p-0 ${color === current ? 'ring-2 ring-primary-6 ring-offset-2' : ''}`}
          style={{ backgroundColor: color }}
        />
      ))}
      <span data-testid='bot-color-custom'>
        <ColorPicker
          format='hex'
          disabledAlpha
          showPreset={false}
          value={isBotColor(value) ? value : undefined}
          onChange={(next) => {
            if (typeof next === 'string' && isBotColor(next)) onChange(next);
          }}
          triggerElement={
            <Button size='mini' type='outline' aria-label={customLabel} className='!rounded-8px !px-8px !text-11px'>
              {isCustom && <BotColorDot color={value} className='me-4px' />}
              {customLabel}
            </Button>
          }
        />
      </span>
    </div>
  );
};

export default BotColorField;
