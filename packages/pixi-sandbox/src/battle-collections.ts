/** 调用方传入准备提交的值；按键替换或追加，保留数组顺序。 */
export function upsertBy<T, K extends keyof T>(items: T[], incoming: T, key: K): void {
  const index = items.findIndex(item => item[key] === incoming[key]);
  if (index === -1) items.push(incoming);
  else items[index] = incoming;
}
