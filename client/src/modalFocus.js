const focusableSelector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function handleModalKeydown(event, dialog, onClose) {
  if (event.key === 'Escape') {
    onClose?.();
    return;
  }
  if (event.key !== 'Tab' || !dialog) return;

  const items = [...dialog.querySelectorAll(focusableSelector)];
  if (!items.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = items[0];
  const last = items.at(-1);
  const active = dialog.ownerDocument.activeElement;
  const activeInside = active === dialog || dialog.contains(active);
  if (event.shiftKey && (!activeInside || active === dialog || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!activeInside || active === dialog || active === last)) {
    event.preventDefault();
    first.focus();
  }
}
