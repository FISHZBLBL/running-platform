declare module "cos-nodejs-sdk-v5";

declare module "bcryptjs" {
  export function hash(value: string, salt: number): Promise<string>;
  export function compare(value: string, hash: string): Promise<boolean>;
  const bcrypt: {
    hash: typeof hash;
    compare: typeof compare;
  };
  export default bcrypt;
}
