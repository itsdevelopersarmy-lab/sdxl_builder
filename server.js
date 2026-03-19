import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import axios from "axios";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    socket.join(userId);
  });
});

const PORT = 10000;
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-cyan-key";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://itsnexverra_db_user:RZsBuFPxaqGcYLsp@cluster0.on8o4xz.mongodb.net/?appName=Cluster0";

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// MongoDB Connection
mongoose.connect(MONGODB_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Connection Error:", err));

// Schemas
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: "user" }, // user, admin
  credits: { type: Number, default: 100 }
});

const ImageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  prompt: String,
  imageUrl: String,
  settings: Object,
  isFavorite: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const ApiConfigSchema = new mongoose.Schema({
  name: { type: String, default: "Stable Horde" },
  apiKey: { type: String, default: "0000000000" },
  curlTemplate: { type: String, default: '{\n  "prompt": "{{prompt}}",\n  "n": {{batch_size}},\n  "params": {\n    "width": {{width}},\n    "height": {{height}},\n    "steps": {{steps}},\n    "sampler": "k_euler",\n    "cfg_scale": {{cfg_scale}},\n    "seed": "{{seed}}"\n  }\n}' },
  apiUrl: { type: String, default: "https://stablehorde.net/api/v2/generate/async" }
});

const User = mongoose.model("User", UserSchema);
const Image = mongoose.model("Image", ImageSchema);
const ApiConfig = mongoose.model("ApiConfig", ApiConfigSchema);

// Initial Admin Setup
async function initAdmin() {
  const admin = await User.findOne({ role: "admin" });
  if (!admin) {
    const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin123", 10);
    await User.create({ username: "admin", password: hashedPassword, role: "admin" });
    console.log("Admin user created");
  }
  const config = await ApiConfig.findOne();
  if (!config) {
    await ApiConfig.create({});
    console.log("Default API Config created");
  } else if (config.name === "Stable Horde" && (!config.curlTemplate.includes("{{width}}") || !config.curlTemplate.includes("{{height}}"))) {
    // Force update stale default template to include width/height placeholders
    config.curlTemplate = '{\n  "prompt": "{{prompt}}",\n  "n": {{batch_size}},\n  "params": {\n    "width": {{width}},\n    "height": {{height}},\n    "steps": {{steps}},\n    "sampler": "k_euler",\n    "cfg_scale": {{cfg_scale}},\n    "seed": "{{seed}}"\n  }\n}';
    await config.save();
    console.log("Updated stale Stable Horde template with width/height placeholders");
  }
}
initAdmin();

// Auth Middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  next();
};

// Routes
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hashedPassword });
    const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, JWT_SECRET);
    res.json({ token, user: { id: user._id, username: user.username, role: user.role } });
  } catch (err) {
    res.status(400).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, JWT_SECRET);
  res.json({ token, user: { id: user._id, username: user.username, role: user.role } });
});

app.get("/api/user/me", authenticate, async (req, res) => {
  const user = await User.findById(req.user.id);
  res.json({ id: user._id, username: user.username, role: user.role });
});

// Admin Routes
app.get("/api/admin/config", authenticate, isAdmin, async (req, res) => {
  const config = await ApiConfig.findOne();
  res.json(config);
});

app.post("/api/admin/config", authenticate, isAdmin, async (req, res) => {
  const { name, apiKey, curlTemplate, apiUrl } = req.body;
  await ApiConfig.findOneAndUpdate({}, { name, apiKey, curlTemplate, apiUrl }, { upsert: true });
  res.json({ message: "Config updated" });
});

// Helper to extract JSON from curl command or return raw JSON
const extractJson = (str) => {
  const trimmed = str.trim();
  if (trimmed.startsWith('curl')) {
    // Try to find the -d or --data part
    const dataMatch = trimmed.match(/-d\s+(['"])([\s\S]*?)\1/) || trimmed.match(/--data\s+(['"])([\s\S]*?)\1/);
    if (dataMatch) return dataMatch[2];
    
    // If no quotes, try to find the first { and last }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      return trimmed.substring(firstBrace, lastBrace + 1);
    }
  }
  return trimmed;
};

// Image Generation
app.post("/api/generate", authenticate, async (req, res) => {
  try {
    const { prompt, steps = 20, width, height, cfg_scale = 7.5, seed, batch_size = 1, upscale = 1 } = req.body;
    
    // Ensure numeric values
    const numWidth = Math.round(Number(width || 896) / 64) * 64;
    const numHeight = Math.round(Number(height || 896) / 64) * 64;
    const numSteps = Number(steps);
    const numCfg = Number(cfg_scale);
    const numBatch = Number(batch_size);
    const numUpscale = Number(upscale);

    const config = await ApiConfig.findOne();
    
    if (!config || !config.apiUrl) {
      return res.status(400).json({ error: "API not configured" });
    }

    const user = await User.findById(req.user.id);

    // Replace placeholders in template
    const finalSeed = (seed === -1 || !seed) ? Math.floor(Math.random() * 1000000000) : seed;
    
    let bodyTemplate = config.curlTemplate
      .replace(/{{prompt}}/g, prompt)
      .replace(/{{steps}}/g, numSteps)
      .replace(/{{width}}/g, numWidth)
      .replace(/{{height}}/g, numHeight)
      .replace(/{{cfg_scale}}/g, numCfg)
      .replace(/{{seed}}/g, finalSeed)
      .replace(/{{batch_size}}/g, numBatch)
      .replace(/{{upscale}}/g, numUpscale);

    const jsonBody = extractJson(bodyTemplate);
    const parsedBody = JSON.parse(jsonBody);

    // Helper to deeply set values in the parsed JSON, ensuring compatibility across different API formats
    const updateField = (obj, key, value) => {
      // Set at root level (common for many SD APIs like Automatic1111)
      obj[key] = value;
      
      // Also set inside params object if it exists (required by Stable Horde and others)
      if (obj.params && typeof obj.params === 'object') {
        obj.params[key] = value;
      }
    };

    // Ensure all values are correctly typed in the final JSON
    updateField(parsedBody, 'prompt', prompt);
    updateField(parsedBody, 'width', numWidth);
    updateField(parsedBody, 'height', numHeight);
    updateField(parsedBody, 'steps', numSteps);
    updateField(parsedBody, 'cfg_scale', numCfg);
    updateField(parsedBody, 'seed', Number(finalSeed));
    
    console.log(`[API Request] URL: ${config.apiUrl}`);
    console.log(`[API Request] Body:`, JSON.stringify(parsedBody, null, 2));
    
    // Stable Horde specific post-processing for upscaling
    if (numUpscale > 1) {
      if (!parsedBody.params) parsedBody.params = {};
      if (!parsedBody.params.post_processing) parsedBody.params.post_processing = [];
      if (!parsedBody.params.post_processing.includes("RealESRGAN_x4plus")) {
        parsedBody.params.post_processing.push("RealESRGAN_x4plus");
      }
    }
    
    // Stable Horde uses 'n' at the root level for number of images
    parsedBody.n = numBatch;
    if (parsedBody.params) {
      parsedBody.params.n = numBatch;
    }

    const response = await axios.post(config.apiUrl, parsedBody, {
      headers: {
        'apikey': config.apiKey,
        'Content-Type': 'application/json'
      }
    });

    // Handle Stable Horde Async Response
    if (response.data.id) {
      const requestId = response.data.id;
      let images = [];

      // Polling for Stable Horde (max 150 seconds)
      for (let i = 0; i < 30; i++) {
        const checkRes = await axios.get(`https://stablehorde.net/api/v2/generate/status/${requestId}`, {
          headers: { 'apikey': config.apiKey }
        });
        
        if (checkRes.data.done) {
          for (const generation of checkRes.data.generations) {
            const savedImage = await Image.create({
              userId: req.user.id,
              prompt,
              imageUrl: generation.img, 
              settings: { steps: numSteps, width: numWidth, height: numHeight, cfg_scale: numCfg, seed: finalSeed, upscale: numUpscale }
            });
            const populatedImage = await Image.findById(savedImage._id).populate('userId', 'username');
            io.emit('new_image', populatedImage);
            images.push(savedImage);
          }
          break;
        }

        const isWaiting = checkRes.data.waiting > 0 || checkRes.data.queue_position > 0;
        const delay = isWaiting ? 5000 : 3000; 
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      return res.json({ images });
    }

    // Fallback for other APIs
    const images = [];
    if (response.data.images) {
      for (const imgBase64 of response.data.images) {
        const savedImage = await Image.create({
          userId: req.user.id,
          prompt,
          imageUrl: imgBase64.startsWith('data:') ? imgBase64 : `data:image/png;base64,${imgBase64}`,
          settings: { steps: numSteps, width: numWidth, height: numHeight, cfg_scale: numCfg, seed: finalSeed, upscale: numUpscale }
        });
        const populatedImage = await Image.findById(savedImage._id).populate('userId', 'username');
        io.emit('new_image', populatedImage);
        images.push(savedImage);
      }
    }

    res.json({ images });
  } catch (err) {
    console.error("Generation Error:", err);
    res.status(500).json({ error: "Generation failed: " + err.message });
  }
});

app.get("/api/history", authenticate, async (req, res) => {
  const images = await Image.find({ userId: req.user.id }).sort({ createdAt: -1 });
  res.json(images);
});

app.get("/api/feed", async (req, res) => {
  try {
    const images = await Image.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('userId', 'username');
    res.json(images);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

app.post("/api/history/:id/favorite", authenticate, async (req, res) => {
  const image = await Image.findOne({ _id: req.params.id, userId: req.user.id });
  if (image) {
    image.isFavorite = !image.isFavorite;
    await image.save();
    io.emit('favorite_update', { id: image._id, isFavorite: image.isFavorite });
  }
  res.json(image);
});

app.delete("/api/history/all", authenticate, async (req, res) => {
  await Image.deleteMany({ userId: req.user.id });
  io.to(req.user.id).emit('clear_history');
  res.json({ message: "All history cleared" });
});

app.delete("/api/history/:id", authenticate, async (req, res) => {
  await Image.deleteOne({ _id: req.params.id, userId: req.user.id });
  io.emit('delete_image', req.params.id);
  res.json({ message: "Deleted" });
});

// Vite middleware for development
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(__dirname, "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
