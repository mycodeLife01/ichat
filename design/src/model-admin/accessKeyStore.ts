let key: string | null = null;
export const modelAdminAccessKeyStore = { read: () => key, save: (value: string) => { key=value; }, clear: () => { key=null; } };
