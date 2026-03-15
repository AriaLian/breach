# Deploy Breach to Vercel via GitHub

## 1. Create a GitHub repository

1. Go to [github.com/new](https://github.com/new).
2. Set **Repository name** to `breach` (or any name you like).
3. Choose **Public**, leave "Add a README" **unchecked** (you already have one).
4. Click **Create repository**.

## 2. Push this project to GitHub

In your project folder, run (replace `YOUR_USERNAME` with your GitHub username):

```bash
git remote add origin https://github.com/YOUR_USERNAME/breach.git
git branch -M main
git push -u origin main
```

If you use SSH:

```bash
git remote add origin git@github.com:YOUR_USERNAME/breach.git
git branch -M main
git push -u origin main
```

## 3. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in (use **Continue with GitHub**).
2. Click **Add New…** → **Project**.
3. **Import** the `breach` repository (or the one you created).
4. Vercel will detect Vite and use:
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
5. Click **Deploy**. Vercel will build and deploy; each push to `main` will trigger a new deployment.

Your game will be live at a URL like `https://breach-xxxx.vercel.app`. You can add a custom domain in the project **Settings** on Vercel.
