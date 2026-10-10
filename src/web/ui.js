/* Progressive enhancements for server-rendered forms. No application state lives here. */
(() => {
  const baselines = new WeakMap();
  const focusedTemplates = new WeakMap();
  let submitting = false;
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const fire = (el) => el.dispatchEvent(new Event('input', { bubbles: true }));
  const snapshot = (form) => {
    const values = {};
    [...form.elements].forEach((el) => {
      if (!el.name || /\.__(?:bool|set)$/.test(el.name) || ['submit', 'button'].includes(el.type)) return;
      if (el.type === 'radio') { if (el.checked) values[el.name] = el.value; }
      else if (el.type === 'checkbox') {
        if (el.value === 'on') values[el.name] = el.checked;
        else { values[el.name] ??= []; if (el.checked) values[el.name].push(el.value); }
      } else values[el.name] = el.value;
    });
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
  };
  const dirty = (form) => {
    const before = baselines.get(form) || {};
    const now = snapshot(form);
    const count = new Set([...Object.keys(before), ...Object.keys(now)]);
    return [...count].filter((name) => before[name] !== now[name]).length;
  };
  const update = (form) => {
    const count = dirty(form);
    const bar = form.querySelector('.save-bar');
    if (bar) bar.hidden = count === 0;
    all('[data-dirty-count]', form).forEach((el) => { el.textContent = `${count} unsaved change${count === 1 ? '' : 's'}`; });
    form.dataset.dirty = count ? 'true' : 'false';
  };
  const conditionMatches = (condition, form) => {
    const controls = [...form.elements].filter((el) => el.name === `cfg.${condition.field}` || el.name === condition.field);
    const el = controls.find((input) => input.type !== 'radio' || input.checked);
    const value = el?.type === 'checkbox' ? el.checked : el?.type === 'number' ? Number(el.value) : el?.value;
    return condition.not !== undefined ? value !== condition.not : value === (condition.equals ?? true);
  };
  const conditions = (form) => {
    all('[data-show-if], [data-disabled-if]', form).forEach((field) => {
      const show = field.dataset.showIf ? conditionMatches(JSON.parse(field.dataset.showIf), form) : true;
      const disabled = field.dataset.disabledIf ? conditionMatches(JSON.parse(field.dataset.disabledIf), form) : false;
      field.hidden = !show;
      field.classList.toggle('is-disabled', disabled);
      all('input, select, textarea, button', field).forEach((el) => { el.disabled = disabled || !show; });
    });
    const rulesToggle = form.querySelector('[data-rules-toggle]');
    const rulesFields = form.querySelector('[data-rules-fields]');
    if (rulesToggle && rulesFields) {
      rulesFields.hidden = !rulesToggle.checked;
      all('input, select, textarea, button', rulesFields).forEach((el) => {
        const condition = el.closest('[data-show-if], [data-disabled-if]');
        el.disabled = !rulesToggle.checked || !!(condition && (condition.hidden || condition.classList.contains('is-disabled')));
      });
    }
  };
  const chipValues = (widget) => widget.querySelector('[data-chips-value]').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const renderChips = (widget) => {
    const list = widget.querySelector('[data-chips-list]');
    list.replaceChildren();
    chipValues(widget).forEach((value) => {
      const chip = document.createElement('span'); chip.className = 'chip';
      const text = document.createElement('span'); text.textContent = value;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.dataset.removeChip = value; remove.setAttribute('aria-label', `Remove ${value}`);
      remove.disabled = widget.querySelector('[data-chips-value]').disabled;
      chip.append(text, remove); list.append(chip);
    });
  };
  const addChip = (widget, value) => {
    const textarea = widget.querySelector('[data-chips-value]');
    if (textarea.disabled || !value.trim()) return;
    const values = chipValues(widget);
    value = value.trim();
    if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
    textarea.value = values.join('\n'); renderChips(widget); fire(textarea);
    widget.querySelector('[data-chips-entry]').value = '';
  };
  const updateMovePositions = (container) => {
    const rows = all('[data-instance-id]', container);
    rows.forEach((row, index) => all('[data-move]', row).forEach((button) => {
      button.disabled = !!container.dataset.sorting || (button.dataset.move === 'up' ? index === 0 : index === rows.length - 1);
    }));
  };
  const saveOrder = async (container) => {
    container.dataset.sorting = 'true';
    updateMovePositions(container);
    const original = container.dataset.savedOrder;
    const ids = all('[data-instance-id]', container).map((row) => row.dataset.instanceId);
    let saved = false;
    try {
      const response = await fetch(container.dataset.reorderUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'HX-Request': 'true' }, body: JSON.stringify({ ids }) });
      if (!response.ok) throw new Error(`Could not save priority (${response.status}).`);
      container.dataset.savedOrder = JSON.stringify(ids);
      saved = true;
    } catch (error) {
      if (original) JSON.parse(original).forEach((id) => {
        const row = all('[data-instance-id]', container).find((item) => item.dataset.instanceId === id);
        if (row) container.append(row);
      });
      const status = document.querySelector('[data-reorder-status]');
      if (status) status.textContent = error.message;
      else window.alert(error.message);
    } finally {
      delete container.dataset.sorting;
      updateMovePositions(container);
    }
    if (saved && window.htmx) window.htmx.trigger(document.body, 'instances-reordered');
  };
  const init = (root = document) => {
    all('.settings-form', root).forEach((form) => {
      if (!baselines.has(form)) baselines.set(form, snapshot(form));
      conditions(form); update(form);
    });
    all('[data-chips]', root).forEach((widget) => {
      widget.querySelector('[data-chips-value]').hidden = true;
      widget.querySelector('[data-chips-control]').hidden = false;
      renderChips(widget);
    });
    all('[data-reorder-url]', root).forEach((container) => {
      updateMovePositions(container);
      if (container.dataset.sortableReady) return;
      container.dataset.sortableReady = 'true';
      container.dataset.savedOrder = JSON.stringify(all('[data-instance-id]', container).map((row) => row.dataset.instanceId));
      if (window.Sortable) window.Sortable.create(container, { animation: 150, handle: '.reorder-handle', draggable: '[data-instance-id]', onStart: () => { container.dataset.sorting = 'true'; updateMovePositions(container); }, onEnd: () => { void saveOrder(container); } });
    });
  };
  document.addEventListener('focusin', (event) => {
    if (event.target.matches('[data-template-input]')) focusedTemplates.set(event.target.closest('.template-panel'), event.target);
  });
  document.addEventListener('input', (event) => {
    const form = event.target.closest('.settings-form');
    if (form) { conditions(form); update(form); }
  });
  document.addEventListener('change', (event) => {
    const form = event.target.closest('.settings-form');
    if (form) { conditions(form); update(form); }
    if (event.target.matches('[data-submit-on-change]')) event.target.closest('form')?.requestSubmit();
  });
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('[data-chips-entry]') && ['Enter', ','].includes(event.key)) {
      event.preventDefault(); addChip(event.target.closest('[data-chips]'), event.target.value);
    }
    if (event.target.matches('[data-tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = all('[data-tab]', event.target.closest('[data-tabs]'));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(event.target) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click(); tabs[next].focus();
    }
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button, [data-copy]');
    if (!button) return;
    if (button.hasAttribute('data-replace-secret')) {
      const input = button.closest('[data-secret]').querySelector('[data-secret-input]');
      input.readOnly = false; input.placeholder = 'Enter replacement key'; input.focus(); button.hidden = true;
    } else if (button.hasAttribute('data-add-chip')) addChip(button.closest('[data-chips]'), button.dataset.addChip);
    else if (button.hasAttribute('data-remove-chip')) {
      const widget = button.closest('[data-chips]');
      const textarea = widget.querySelector('[data-chips-value]');
      textarea.value = chipValues(widget).filter((value) => value !== button.dataset.removeChip).join('\n');
      renderChips(widget); fire(textarea);
    } else if (button.hasAttribute('data-insert-variable')) {
      const panel = button.closest('.template-panel');
      const input = focusedTemplates.get(panel) || panel.querySelector('[data-template-input]');
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const variable = button.dataset.insertVariable;
      input.value = input.value.slice(0, start) + variable + input.value.slice(end);
      input.focus(); input.setSelectionRange(start + variable.length, start + variable.length); fire(input);
    } else if (button.hasAttribute('data-tab')) {
      const widget = button.closest('[data-tabs]');
      all('[data-tab]', widget).forEach((tab) => { const active = tab === button; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
      all('[data-tab-panel]', widget).forEach((panel) => { panel.hidden = panel.dataset.tabPanel !== button.dataset.tab; });
    } else if (button.hasAttribute('data-discard')) {
      const form = button.closest('.settings-form');
      form.reset();
      all('[data-secret]', form).forEach((secret) => {
        const replace = secret.querySelector('[data-replace-secret]');
        if (replace) { replace.hidden = false; const input = secret.querySelector('[data-secret-input]'); input.readOnly = true; input.placeholder = '••••••••••••••••'; }
      });
      all('[data-chips]', form).forEach((widget) => { widget.querySelector('[data-chips-entry]').value = ''; renderChips(widget); });
      conditions(form); update(form);
    } else if (button.hasAttribute('data-copy')) {
      const target = button.dataset.copyTarget ? document.querySelector(button.dataset.copyTarget) : null;
      const value = target ? target.value ?? target.textContent : button.dataset.copy;
      const contents = [...button.childNodes].map((node) => node.cloneNode(true));
      try {
        if (!navigator.clipboard || !window.isSecureContext) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(value); button.textContent = 'Copied';
      } catch {
        const input = target?.select ? target : document.createElement('textarea');
        if (input !== target) { input.value = value; input.className = 'copy-fallback'; button.after(input); }
        input.focus(); input.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch { /* Leave the text selected for keyboard copy. */ }
        button.textContent = copied ? 'Copied' : 'Selected · press Ctrl/Cmd+C';
        if (copied && input !== target) input.remove();
      }
      setTimeout(() => { button.replaceChildren(...contents); }, 2500);
    } else if (button.hasAttribute('data-move')) {
      const row = button.closest('[data-instance-id]');
      const container = row.closest('[data-reorder-url]');
      const rows = all('[data-instance-id]', container);
      const index = rows.indexOf(row);
      const next = button.dataset.move === 'up' ? rows[index - 1] : rows[index + 1];
      if (next) { button.dataset.move === 'up' ? next.before(row) : next.after(row); void saveOrder(container); button.focus(); }
    }
  });
  document.addEventListener('submit', (event) => {
    if (!event.target.matches('.settings-form')) return;
    all('[data-chips]', event.target).forEach((widget) => addChip(widget, widget.querySelector('[data-chips-entry]').value));
    submitting = true;
  });
  document.addEventListener('htmx:beforeSwap', (event) => {
    // Keep a dragged row from disappearing during a live refresh.
    if (event.detail.target?.matches('[data-sorting]') || event.detail.target?.querySelector('[data-sorting]')) event.detail.shouldSwap = false;
  });
  document.addEventListener('htmx:afterSwap', () => init());
  window.addEventListener('beforeunload', (event) => {
    if (!submitting && all('.settings-form').some((form) => dirty(form))) { event.preventDefault(); event.returnValue = ''; }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init()); else init();
})();
