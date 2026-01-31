require('dotenv').config(); // MUST BE AT THE VERY TOP
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
const port = 5003;

app.use(cors());
app.use(express.json());

// Verify MongoDB URI exists
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error("ERROR: MONGO_URI is missing from .env file");
  process.exit(1);
}

const dbName = "synergic";
const paperCollection = "paper_details";
let db;

// MongoDB Connection
MongoClient.connect(mongoURI)
  .then(client => {
    db = client.db(dbName);
    console.log("✅ Connected to MongoDB: synergic");
  })
  .catch(err => console.error("❌ MongoDB connection error:", err));

// Google Drive Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
const drive = google.drive({ version: "v3", auth: oauth2Client });

// Helper: Extract File ID from Drive Link
const getFileId = (link) => {
  const match = link?.match(/\/d\/(.*?)(\/|$)/);
  return match ? match[1] : null;
};

// --- ENDPOINTS ---

// GET: Fetch only duplicate pairs (Subject + Year + Type)
app.get("/duplicates", async (req, res) => {
  try {
    const collection = db.collection(paperCollection);

    const duplicates = await collection.aggregate([
      {
        // 1. Filter out ClassTests
        $match: { Type: { $ne: "ClassTest" } }
      },
      {
        // 2. Group by duplicate criteria
        $group: {
          _id: {
            subject: "$subject",
            yearOfStudy: "$yearOfStudy",
            Type: "$Type"
          },
          files: { $push: "$$ROOT" },
          count: { $sum: 1 }
        }
      },
      {
        // 3. Only keep groups with duplicates
        $match: { count: { $gt: 1 } }
      }
    ]).toArray();

    // Flattening for the frontend
    const result = duplicates.flatMap(group => group.files);
    res.json(result);
  } catch (error) {
    console.error("Fetch Error:", error);
    res.status(500).json({ message: "Error fetching duplicates" });
  }
});

// DELETE: Remove file from DB and Google Drive
app.delete("/remove-duplicate/:id", async (req, res) => {
  try {
    const collection = db.collection(paperCollection);
    const id = req.params.id;

    const file = await collection.findOne({ _id: new ObjectId(id) });
    if (!file) return res.status(404).json({ message: "File not found" });

    // 1. Delete from MongoDB
    await collection.deleteOne({ _id: new ObjectId(id) });

    // 2. Delete from Google Drive
    const driveId = getFileId(file.driveLink);
    if (driveId) {
      try {
        await drive.files.delete({ fileId: driveId });
        console.log(`Deleted Drive File: ${driveId}`);
      } catch (driveErr) {
        console.warn("Drive deletion failed or file already gone:", driveErr.message);
      }
    }

    res.json({ message: "Deleted successfully from DB and Drive" });
  } catch (error) {
    console.error("Delete Error:", error);
    res.status(500).json({ message: "Error deleting file" });
  }
});

app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));