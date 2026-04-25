require('dotenv').config(); // MUST BE AT THE VERY TOP
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const { google } = require("googleapis");
const mongoose = require('mongoose');

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

const subjectCollection = "subject_details"; // New collection for curriculum structure

app.get("/subject-structure", async (req, res) => {
  try {
    const collection = db.collection(subjectCollection);

    // Since the entire data is in one ID/document, we find the first one
    const structure = await collection.findOne({});

    if (!structure) {
      return res.status(404).json({ message: "No subject data found" });
    }

    // Return the document (which contains BTech, MTech, etc.)
    res.json(structure);
  } catch (error) {
    console.error("Fetch Structure Error:", error);
    res.status(500).json({ message: "Error fetching subject structure" });
  }
});

app.get("/allpapers", async (req, res) => {
  try {
    const collection = db.collection(paperCollection);
    
    // Fetch all papers, sorted by most recently uploaded
    const papers = await collection.find({}).sort({ uploadedAt: -1 }).toArray();
    
    res.json(papers);
  } catch (error) {
    console.error("Fetch All Papers Error:", error);
    res.status(500).json({ message: "Error fetching paper records" });
  }
});




app.get("/unverified-papers", async (req, res) => {
  try {
    const collection = db.collection(paperCollection);
    
    // Fetch papers where isVerified is specifically false
    const unverified = await collection
      .find({ isVerified: false })
      .sort({ uploadedAt: -1 })
      .toArray();
    
    res.json(unverified);
  } catch (error) {
    console.error("Fetch Unverified Papers Error:", error);
    res.status(500).json({ message: "Error fetching unverified paper records" });
  }
});

app.patch("/verify-paper/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const collection = db.collection(paperCollection);

    const result = await collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) }, // Fixed here
      { $set: { isVerified: true } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Paper record not found" });
    }

    res.json({ success: true, message: "Paper verified successfully" });
  } catch (error) {
    console.error("Verify Paper Error:", error);
    res.status(500).json({ message: "Error updating verification status" });
  }
});
app.delete("/deny-paper/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const collection = db.collection(paperCollection);

    const result = await collection.deleteOne({ 
      _id: new mongoose.Types.ObjectId(id) // Fixed here
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Paper record not found" });
    }

    res.json({ success: true, message: "Paper denied and removed from system" });
  } catch (error) {
    console.error("Deny Paper Error:", error);
    res.status(500).json({ message: "Error removing paper record" });
  }
});


// GET: Fetch subjects based on degree, branch, and semester
// Example: /subjects/BTech/CSE/Semester_3
app.get("/subjects/:degree/:branch/:semester", async (req, res) => {
  try {
    const { degree, branch, semester } = req.params;
    const collection = db.collection(subjectCollection);

    // 1. Fetch the curriculum document
    const structure = await collection.findOne({});

    if (!structure) {
      return res.status(404).json({ message: "Curriculum data not found" });
    }

    // 2. Navigate the nested structure using bracket notation
    // structure -> BTech -> CSE -> Semester_3
    try {
      const subjects = structure[degree][branch][semester];

      if (!subjects) {
        return res.status(404).json({ 
          message: `No subjects found for ${degree} > ${branch} > ${semester}` 
        });
      }

      res.json(subjects);
    } catch (err) {
      // This catches cases where degree or branch keys don't exist
      res.status(404).json({ message: "Invalid Degree or Branch path" });
    }

  } catch (error) {
    console.error("Fetch Subjects Error:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});


// PUT: Replace the entire subjects array for a specific semester
// URL Example: /update-subjects/BTech/CSE/chemistry-Semester
app.put("/update-subjects/:degree/:branch/:semester", async (req, res) => {
  try {
    const { degree, branch, semester } = req.params;
    const newSubjects = req.body;

    if (!Array.isArray(newSubjects)) {
      return res.status(400).json({ message: "Invalid data format." });
    }

    const collection = db.collection(subjectCollection);
    const allSubjectsCollection = db.collection("all_subjects");

    // 1. Gather subjects to sync
    let subjectsToSync = [];

    newSubjects.forEach(sub => {
      // A. Handle Standard Subjects (Must have name AND code)
      if (sub.name && sub.code && sub.code.trim() !== "") {
        subjectsToSync.push({ name: sub.name, code: sub.code });
      }
      
      // B. Handle Elective Groups (Look for the options array regardless of isNested flag)
      if (sub.options && Array.isArray(sub.options) && sub.options.length > 0) {
        sub.options.forEach(opt => {
          if (opt.name && opt.code && opt.code.trim() !== "") {
            subjectsToSync.push({ name: opt.name, code: opt.code });
          }
        });
      }
    });


    // 2. Perform Bulk Write with $set instead of $setOnInsert
    if (subjectsToSync.length > 0) {
      const bulkOps = subjectsToSync.map(s => ({
        updateOne: {
          filter: { name: s.name }, 
          // Use $set to ensure the code is updated if it already exists
          update: { $set: { name: s.name, code: s.code } }, 
          upsert: true
        }
      }));
      await allSubjectsCollection.bulkWrite(bulkOps);
    }

    // 3. Update the main curriculum document
    const updatePath = `${degree}.${branch}.${semester}`;
    const result = await collection.updateOne(
      {}, 
      { $set: { [updatePath]: newSubjects } }
    );

    res.json({ 
      success: true, 
      message: `Updated ${semester} and synced ${subjectsToSync.length} subjects.`,
    });

  } catch (error) {
    console.error("Update/Sync Error:", error);
    res.status(500).json({ message: "Error updating subjects" });
  }
});




app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));