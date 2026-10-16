import { ipcBridge } from '@/common';
import { NOTE_LIMITS, type Note, type NoteSource } from '@/common/types/agent/artifacts';
import { Button, Input, Message, Tag } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SectionCard } from './editorSectionPrimitives';

type AgentNotebookProps = {
  agentId: string;
};

const SOURCE_TAGS: Record<NoteSource, { key: string; defaultValue: string; color: string }> = {
  agent: { key: 'agent.notebook.source.agent', defaultValue: 'Learned', color: 'arcoblue' },
  user: { key: 'agent.notebook.source.user', defaultValue: 'Instruction', color: 'green' },
  page: { key: 'agent.notebook.source.page', defaultValue: 'From a web page', color: 'orange' },
};

/**
 * The Agent's notebook in its editor: what the agent learned, notes it took from web pages, and the user's own
 * instructions, newest first. Every change is saved at once and reaches the Agent's instructions in new chats.
 */
const AgentNotebook: React.FC<AgentNotebookProps> = ({ agentId }) => {
  const { t } = useTranslation();
  const [messageApi, messageContext] = Message.useMessage();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [newDraft, setNewDraft] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setNotes(null);
    setLoadFailed(false);
    ipcBridge.agentNotes.list
      .invoke({ agentId })
      .then((reply) => {
        if (!live) return;
        setNotes(reply.success ? (reply.data ?? []) : []);
        setLoadFailed(!reply.success);
      })
      .catch(() => {
        if (!live) return;
        setNotes([]);
        setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [agentId]);

  const saveFailed = () =>
    messageApi.error(t('agent.notebook.saveFailed', { defaultValue: "Couldn't save the note." }));

  const handleSaveEdit = async () => {
    const text = editing?.draft.trim();
    if (!editing || !text) return;
    const reply = await ipcBridge.agentNotes.update.invoke({ agentId, id: editing.id, text }).catch((): null => null);
    const updated = reply?.success ? reply.data : undefined;
    if (!updated) return saveFailed();
    setNotes((prev) => prev?.map((n) => (n.id === updated.id ? updated : n)) ?? prev);
    setEditing(null);
  };

  const handleAdd = async () => {
    const text = newDraft?.trim();
    if (!text) return;
    const reply = await ipcBridge.agentNotes.add.invoke({ agentId, text }).catch((): null => null);
    const added = reply?.success ? reply.data : undefined;
    if (!added) return saveFailed();
    setNotes((prev) => [...(prev ?? []), added]);
    setNewDraft(null);
  };

  const handleDelete = async (id: string) => {
    const reply = await ipcBridge.agentNotes.delete.invoke({ agentId, id }).catch((): null => null);
    if (!reply?.success) {
      messageApi.error(t('agent.notebook.deleteFailed', { defaultValue: "Couldn't delete the note." }));
      return;
    }
    setNotes((prev) => prev?.filter((n) => n.id !== id) ?? prev);
  };

  const newestFirst = (notes ?? []).toSorted((a, b) => b.at - a.at);

  return (
    <SectionCard
      title={t('agent.notebook.title', { defaultValue: 'Notebook' })}
      extra={
        <Button type='outline' size='small' className='!rounded-full' onClick={() => setNewDraft('')}>
          {t('agent.notebook.addInstruction', { defaultValue: 'Add instruction' })}
        </Button>
      }
      testId='assistant-card-notebook'
    >
      {messageContext}
      <div className='mb-8px text-12px leading-18px text-t-tertiary'>
        {t('agent.notebook.hint', {
          defaultValue:
            'What this Agent learned, and your instructions. They are added to its instructions in new chats.',
        })}
      </div>
      {newDraft !== null ? (
        <div className='mb-8px flex items-center gap-8px rounded-10px bg-fill-1 p-4px'>
          <Input
            value={newDraft}
            onChange={setNewDraft}
            maxLength={NOTE_LIMITS.maxChars}
            placeholder={t('agent.notebook.placeholder', { defaultValue: 'An instruction for this Agent' })}
            data-testid='agent-note-new-input'
          />
          <Button size='small' type='primary' className='!rounded-full' onClick={() => void handleAdd()}>
            {t('common.add', { defaultValue: 'Add' })}
          </Button>
          <Button size='small' type='secondary' className='!rounded-full' onClick={() => setNewDraft(null)}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
        </div>
      ) : null}
      {loadFailed ? (
        <div className='text-13px text-t-secondary'>
          {t('agent.notebook.loadFailed', { defaultValue: "Couldn't load the notebook." })}
        </div>
      ) : notes !== null && newestFirst.length === 0 ? (
        <div className='text-13px text-t-secondary'>{t('agent.notebook.empty', { defaultValue: 'No notes yet.' })}</div>
      ) : (
        <div className='space-y-4px'>
          {newestFirst.map((note) => {
            const tag = SOURCE_TAGS[note.source];
            const isEditing = editing?.id === note.id;
            return (
              <div key={note.id} data-testid='agent-note' className='flex items-center gap-10px py-4px'>
                <Tag size='small' color={tag.color} className='flex-shrink-0'>
                  {t(tag.key, { defaultValue: tag.defaultValue })}
                </Tag>
                {isEditing ? (
                  <>
                    <Input
                      value={editing.draft}
                      onChange={(draft) => setEditing({ id: note.id, draft })}
                      maxLength={NOTE_LIMITS.maxChars}
                      data-testid='agent-note-edit-input'
                    />
                    <Button size='small' type='primary' className='!rounded-full' onClick={() => void handleSaveEdit()}>
                      {t('common.save', { defaultValue: 'Save' })}
                    </Button>
                    <Button size='small' type='secondary' className='!rounded-full' onClick={() => setEditing(null)}>
                      {t('common.cancel', { defaultValue: 'Cancel' })}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className='min-w-0 flex-1 break-words text-13px leading-18px text-t-primary'>{note.text}</div>
                    <Button
                      size='small'
                      type='secondary'
                      className='!rounded-full'
                      onClick={() => setEditing({ id: note.id, draft: note.text })}
                    >
                      {t('common.edit', { defaultValue: 'Edit' })}
                    </Button>
                    <Button
                      size='small'
                      type='secondary'
                      className='!rounded-full'
                      onClick={() => void handleDelete(note.id)}
                    >
                      {t('common.delete', { defaultValue: 'Delete' })}
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
};

export default AgentNotebook;
