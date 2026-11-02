import { describe, expect, it, vi } from 'vitest';
import { handleModalKeydown } from './modalFocus.js';

function fixture() {
  const document = { activeElement: null };
  const dialog = {
    ownerDocument: document,
    focus: vi.fn(() => { document.activeElement = dialog; }),
    contains: element => elements.includes(element),
    querySelectorAll: () => elements,
  };
  const elements = [
    { focus: vi.fn(() => { document.activeElement = elements[0]; }) },
    { focus: vi.fn(() => { document.activeElement = elements[1]; }) },
  ];
  return { document, dialog, elements };
}

function key(key, shiftKey = false) {
  return { key, shiftKey, preventDefault: vi.fn() };
}

describe('modal keyboard interaction', () => {
  it('moves Tab from the dialog container to the first control', () => {
    const { document, dialog, elements } = fixture();
    document.activeElement = dialog;
    const event = key('Tab');
    handleModalKeydown(event, dialog);
    expect(elements[0].focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('wraps Shift+Tab from the dialog container to the last control', () => {
    const { document, dialog, elements } = fixture();
    document.activeElement = dialog;
    const event = key('Tab', true);
    handleModalKeydown(event, dialog);
    expect(elements[1].focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('wraps forward and backward at the ends of the focusable controls', () => {
    const { document, dialog, elements } = fixture();
    document.activeElement = elements[1];
    handleModalKeydown(key('Tab'), dialog);
    expect(elements[0].focus).toHaveBeenCalledOnce();
    document.activeElement = elements[0];
    handleModalKeydown(key('Tab', true), dialog);
    expect(elements[1].focus).toHaveBeenCalledOnce();
  });

  it('closes on Escape and keeps focus inside when there are no controls', () => {
    const { document, dialog } = fixture();
    const onClose = vi.fn();
    handleModalKeydown(key('Escape'), dialog, onClose);
    expect(onClose).toHaveBeenCalledOnce();
    dialog.querySelectorAll = () => [];
    const event = key('Tab');
    handleModalKeydown(event, dialog);
    expect(dialog.focus).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
