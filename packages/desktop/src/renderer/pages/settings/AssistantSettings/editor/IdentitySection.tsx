import EmojiPicker from '@/renderer/components/chat/EmojiPicker';
import { Avatar, Button, Input } from '@arco-design/web-react';
import type { BuiltinAvatarOption } from '../types';
import React from 'react';
import { useTranslation } from 'react-i18next';
import BotColorField from './BotColorField';
import { FieldLabel, SectionCard } from './editorSectionPrimitives';

type IdentitySectionProps = {
  isIdentityLocked: boolean;
  isDescriptionReadOnly: boolean;
  editAvatar: string;
  editName: string;
  setEditName: (value: string) => void;
  editDescription: string;
  setEditDescription: (value: string) => void;
  setEditAvatar: (value: string) => void;
  setEditAvatarPreview: (value: string | undefined) => void;
  onPickAvatarImage: () => void;
  renderAvatarPreview: () => React.ReactNode;
  builtinAvatarOptions: BuiltinAvatarOption[];
  readOnlyLabel: string;
  /** The Agent's color; the Color row is hidden without it. */
  color?: string;
  setColor?: (value: string) => void;
};

const IdentitySection: React.FC<IdentitySectionProps> = ({
  isIdentityLocked,
  isDescriptionReadOnly,
  editAvatar,
  editName,
  setEditName,
  editDescription,
  setEditDescription,
  setEditAvatar,
  setEditAvatarPreview,
  onPickAvatarImage,
  renderAvatarPreview,
  builtinAvatarOptions,
  readOnlyLabel,
  color,
  setColor,
}) => {
  const { t } = useTranslation();
  const isIdentityEditable = !isIdentityLocked;
  const isDescriptionEditable = !isDescriptionReadOnly;

  return (
    <SectionCard
      title={t('settings.assistantIdentitySection', { defaultValue: 'Identity' })}
      legend={{
        label: t('settings.assistantEffectiveImmediately', { defaultValue: 'Applies immediately' }),
        tone: 'now',
      }}
      readOnly={isIdentityLocked && isDescriptionReadOnly}
      readOnlyLabel={readOnlyLabel}
      testId='assistant-card-identity'
    >
      <div className='flex items-start gap-14px'>
        {!isIdentityEditable ? (
          <Avatar shape='square' size={42} className='!rounded-10px bg-fill-1'>
            {renderAvatarPreview()}
          </Avatar>
        ) : (
          <div className='flex flex-col items-center gap-8px'>
            <EmojiPicker
              value={editAvatar}
              builtinAvatars={builtinAvatarOptions}
              onChange={(emoji) => {
                setEditAvatarPreview(undefined);
                setEditAvatar(emoji);
              }}
              placement='br'
            >
              <Button
                type='text'
                data-testid='btn-assistant-avatar-emoji'
                className='!h-42px !w-42px !rounded-10px !bg-fill-1 !p-0'
              >
                <Avatar shape='square' size={42} className='!rounded-10px bg-fill-1'>
                  {renderAvatarPreview()}
                </Avatar>
              </Button>
            </EmojiPicker>
            <Button
              type='outline'
              size='mini'
              data-testid='btn-assistant-avatar-upload'
              className='!rounded-8px !border-arco-2 !bg-base !px-8px !text-11px'
              onClick={onPickAvatarImage}
            >
              {t('settings.assistantAvatarUploadImage', { defaultValue: 'Upload image' })}
            </Button>
          </div>
        )}
        <div className='min-w-0 flex-1 space-y-10px'>
          <div className='flex items-center gap-12px'>
            <FieldLabel required>{t('settings.assistantName', { defaultValue: 'Name' })}</FieldLabel>
            <Input
              value={editName}
              onChange={(value) => setEditName(value)}
              disabled={!isIdentityEditable}
              placeholder={t('settings.agentNamePlaceholder', { defaultValue: 'Enter a name for this agent' })}
              data-testid='input-assistant-name'
              className='rounded-8px border-arco-2 bg-base'
            />
          </div>
          <div className='flex items-center gap-12px'>
            <FieldLabel>{t('settings.assistantDescription', { defaultValue: 'Description' })}</FieldLabel>
            <Input
              value={editDescription}
              onChange={(value) => setEditDescription(value)}
              disabled={!isDescriptionEditable}
              data-testid='input-assistant-desc'
              placeholder={t('settings.assistantDescriptionPlaceholder', {
                defaultValue: 'What can this Agent help with?',
              })}
              className='rounded-8px border-arco-2 bg-base'
            />
          </div>
          {color && setColor ? (
            <div className='flex items-start gap-12px'>
              <FieldLabel>{t('settings.botColor.label', { defaultValue: 'Color' })}</FieldLabel>
              <BotColorField value={color} onChange={setColor} />
            </div>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
};

export default IdentitySection;
