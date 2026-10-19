export const CHAT_SURFACE_CONTAINER_CLASS = 'chat-surface-container';

export const CHAT_SURFACE_WIDTH_CLASS = 'chat-surface-fluid';

/**
 * Width class for shared chat rows and send boxes. `.chat-surface-fluid` is
 * full-width by default and only reserves side gutters once its *container* is
 * wide enough (see messages.css), so the layout follows the column a chat is
 * given.
 */
export const getChatSurfaceWidthClass = (): string => CHAT_SURFACE_WIDTH_CLASS;
