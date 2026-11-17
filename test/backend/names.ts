let n = 0;
export const freshName = (): string => `t${String(++n)}-${Math.random().toString(36).slice(2)}`;
