import { Writable } from "node:stream";
import { createInterface } from "node:readline";
import { createPasswordHash } from "../src/services/sessionAuth";

let muted = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  }
});

const readline = createInterface({
  input: process.stdin,
  output,
  terminal: true
});

const askHidden = (prompt: string) => (
  new Promise<string>(resolve => {
    muted = false;
    readline.question(prompt, answer => {
      muted = false;
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  })
);

const main = async () => {
  const password = await askHidden("请输入登录密码（至少 12 位）：");
  const confirmation = await askHidden("请再次输入登录密码：");
  readline.close();

  if (password !== confirmation) {
    throw new Error("两次输入的密码不一致");
  }

  const passwordHash = await createPasswordHash(password);
  process.stdout.write(`${passwordHash}\n`);
};

main().catch(error => {
  readline.close();
  const message = error instanceof Error ? error.message : "生成密码哈希失败";
  console.error(message);
  process.exitCode = 1;
});
