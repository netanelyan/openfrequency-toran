# ToranBot

ToranBot is the crawler of Toran, a small Israeli project that builds WhatsApp assistants for online stores. If
you saw `ToranBot/0.1` in your logs, here is what it did and how to stop it.

**What it reads**

- your home page and a contact page
- your public product feed (`/products.json` on Shopify, the public Store API on WooCommerce)
- your shipping, returns and payment policy pages

**How it behaves**

- It reads `robots.txt` first and obeys it for every path. Disallow `/` for `ToranBot`, or for everyone, and it
  never comes back.
- It makes one request at a time to your site, at least a second apart.
- It never submits a form, never adds to a cart, never logs in, and never sends anything to you or your customers.

**Stopping it**

Add this to your robots.txt:

```
User-agent: ToranBot
Disallow: /
```

You can also open an issue on this repository and your domain will be removed and never visited again.
