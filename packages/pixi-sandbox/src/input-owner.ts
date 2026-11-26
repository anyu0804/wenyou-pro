export type InputOwner = 'map' | 'fieldbattle';

let inputOwner: InputOwner = 'map';

export function setInputOwner(owner: InputOwner): void {
  inputOwner = owner;
}

export function getInputOwner(): InputOwner {
  return inputOwner;
}

export function isFieldBattleOwner(): boolean {
  return inputOwner === 'fieldbattle';
}

export function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
}
