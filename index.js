const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const { google } = require("googleapis");
const app = express();
const port = 5003;
require('dotenv').config();
app.use(cors());
app.use(express.json());
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET =process.env.CLIENT_SECRET;
const REDIRECT_URI =process.env.REDIRECT_URI;
const REFRESH_TOKEN =process.env.REFRESH_TOKEN;

const mongoURI =process.env.MONGO_URI;


const dbName = "synergic";
const collectionName = "request_details";
const paperCollection = "paper_details";

let db;

MongoClient.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(client => {
    db = client.db(dbName);
    console.log("Connected to MongoDB");
  })
  .catch(err => console.error("MongoDB connection error:", err));

app.get("/files", async (req, res) => {
  try {
    const collection = db.collection(collectionName);
    const files = await collection.find({}).toArray();
    res.json(files);
  } catch (error) {
    res.status(500).json({ message: "Error fetching data", error });
  }
});

app.post("/add", async (req, res) => {
  try {
    const collection = db.collection(paperCollection);
    const oldCollection = db.collection(collectionName);

    const fileId = req.body._id ? new ObjectId(req.body._id) : new ObjectId();
    const fileData = {
      _id: fileId,
      filename: req.body.filename,
      subject: req.body.subject,
      yearOfStudy: req.body.yearOfStudy,
      driveLink: req.body.driveLink,
      branch: req.body.branch,
      semester: req.body.semester,
      uploadedAt: req.body.uploadedAt,
    };

    const result = await collection.insertOne(fileData);
    const results = await oldCollection.deleteOne({ _id: fileId });

    res.json({
      message: "File added and removed successfully",
      addResult: result,
      removeResult: results,
    });
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).json({ message: "Error processing data", error });
  }
});

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: "v3", auth: oauth2Client });

const getFileIdFromDriveLink = (driveLink) => {
  const match = driveLink.match(/\/d\/(.*?)(\/|$)/);
  return match ? match[1] : null;
};

const deleteDriveFile = async (driveLink) => {
  const fileId = getFileIdFromDriveLink(driveLink);
  if (!fileId) {
    console.log("Invalid Drive Link, skipping deletion.");
    return { success: false, message: "Invalid Drive Link" };
  }
  try {
    await drive.files.delete({ fileId });
    console.log(`Deleted Google Drive file: ${fileId}`);
    return { success: true, message: "Google Drive file deleted successfully" };
  } catch (error) {
    console.error("Error deleting Google Drive file:", error);
    return { success: false, message: "Failed to delete Google Drive file", error };
  }
};

app.delete("/remove/:_id", async (req, res) => {
  try {
    const collection = db.collection(collectionName);
    const fileId = req.params._id;

    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({ message: "Invalid file ID" });
    }

    const fileToDelete = await collection.findOne({ _id: new ObjectId(fileId) });
    if (!fileToDelete) {
      return res.status(404).json({ message: "File not found" });
    }

    const result = await collection.deleteOne({ _id: new ObjectId(fileId) });
    const driveDeleteResponse = await deleteDriveFile(fileToDelete.driveLink);

    res.json({
      message: "File removed from MongoDB and Google Drive",
      deletedFile: fileToDelete,
      result,
      driveDeleteResponse,
    });
  } catch (error) {
    console.error("Error removing file:", error);
    res.status(500).json({ message: "Error removing data", error });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
