// npm run user:add -- <name>   (the password is read from TORAN_NEW_PASSWORD, so it never sits in shell history)
import { makeApp } from '../src/app.ts';
import { addUser } from '../src/web/auth.ts';

const name = process.argv[2];
const pass = process.env.TORAN_NEW_PASSWORD || '';
if (!name || pass.length < 12) {
  console.log('usage: TORAN_NEW_PASSWORD=<12+ characters> npm run user:add -- <name>');
  process.exit(1);
}
const app = await makeApp({ quiet: true });
await addUser(app.db, name, pass);
console.log(`user ${name} added`);
await app.db.close();
