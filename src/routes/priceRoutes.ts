import express from "express";
import getDb from "../config/database";

const router = express.Router();

router.get("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const priceRecords = await db.all("SELECT * FROM price_records");
    res.json({ status: "success", data: priceRecords });
  } catch (error) {
    res.status(500).json({ status: "error", message: "Failed to fetch price records", error: error.message });
  }
});

router.post("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const { date, category, object_name, variant, price, source, note } = req.body;
    const now = new Date().toISOString();
    const result = await db.run("INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [date, category, object_name, variant, price, source, note, now, now]);
    res.json({ status: "success", message: "Price record inserted", id: result.lastID });
  } catch (error) {
    res.status(500).json({ status: "error", message: "Failed to insert price record", error: error.message });
  }
});

router.put("/price-records/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { date, category, object_name, variant, price, source, note } = req.body;
    const now = new Date().toISOString();
    const result = await db.run("UPDATE price_records SET date = ?, category = ?, object_name = ?, variant = ?, price = ?, source = ?, note = ?, updated_at = ? WHERE id = ?", [date, category, object_name, variant, price, source, note, now, id]);
    res.json({ status: "success", message: "Price record updated", changes: result.changes });
  } catch (error) {
    res.status(500).json({ status: "error", message: "Failed to update price record", error: error.message });
  }
});

export default router;
