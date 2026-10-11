interface SaveBarProps {
  message: string;
  button?: string;
}

export function SaveBar({ message, button = 'Save and restart' }: SaveBarProps) {
  return (
    <>
      <div class="save-bar" hidden>
        <span>
          <span data-dirty-count>0 unsaved changes</span>. {message}
        </span>
        <div class="actions">
          <button type="button" class="btn" data-discard>Discard</button>
          <button class="btn primary" type="submit">{button}</button>
        </div>
      </div>
      <noscript>
        <button type="submit" class="btn primary">{button}</button>
      </noscript>
    </>
  );
}
