/** Short display form of a model id: the segment after the last "/". */
export function shortModelName(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}
