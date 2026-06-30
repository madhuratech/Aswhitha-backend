const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../config/database");
const authMiddleware = require("../middleware/auth");

// ── Users table migration + seed on startup ──────────────────────────────────
(async () => {
  try {
    await db.promise().query(
      `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role ENUM('super_admin', 'admin', 'manager', 'employee') DEFAULT 'employee',
        status ENUM('active', 'inactive') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`
    );
    console.log("Users table ready");

    // Seed default admin if no users exist
    const [rows] = await db.promise().query("SELECT COUNT(*) AS cnt FROM users");
    if (rows[0].cnt === 0) {
      const hashed = await bcrypt.hash("Aswitha@123", 10);
      await db.promise().query(
        "INSERT INTO users (username, email, password, name, role) VALUES (?, ?, ?, ?, ?)",
        ["Aswithatech", "Aswithatech@gmail.com", hashed, "Aswitha Tech", "super_admin"]
      );
      console.log("Default admin user seeded (Aswithatech / Aswitha@123)");
    }

    // Migrate old admin user to new credentials
    const [oldAdmin] = await db.promise().query("SELECT id FROM users WHERE username = 'admin'");
    if (oldAdmin.length > 0) {
      const hashed = await bcrypt.hash("Aswitha@123", 10);
      await db.promise().query(
        "UPDATE users SET username = ?, email = ?, password = ?, name = ? WHERE id = ?",
        ["Aswithatech", "Aswithatech@gmail.com", hashed, "Aswitha Tech", oldAdmin[0].id]
      );
      console.log("Admin user migrated to Aswithatech / Aswitha@123");
    }
  } catch (e) {
    console.error("Users table migration error:", e.message);
  }
})();

// ── POST /login ──────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    const [rows] = await db.promise().query(
      "SELECT * FROM users WHERE (username = ? OR email = ?) AND status = 'active'",
      [username, username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid Username or Password." });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: "Invalid Username or Password." });
    }

    const payload = { id: user.id, username: user.username, name: user.name, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    });

    res.json({ token, user: payload });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ── POST /register (admin only, for creating additional users) ──────────────
router.post("/register", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "super_admin" && req.user.role !== "Aswithatech") {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    const { username, email, password, name, role } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ message: "Username, password, and name are required" });
    }

    const [existing] = await db.promise().query(
      "SELECT id FROM users WHERE username = ? OR email = ?",
      [username, email || ""]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: "Username or email already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.promise().query(
      "INSERT INTO users (username, email, password, name, role) VALUES (?, ?, ?, ?, ?)",
      [username, email || null, hashed, name, role || "employee"]
    );

    res.status(201).json({ message: "User created successfully" });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ── GET /me (returns current authenticated user) ─────────────────────────────
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      "SELECT id, username, email, name, role, status, created_at FROM users WHERE id = ?",
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json({ user: rows[0] });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ── POST /change-password ────────────────────────────────────────────────────
router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      return res.status(400).json({ message: "Current password, new password, and confirm password are required" });
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ message: "New passwords do not match" });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ message: "New password cannot be the same as the current password" });
    }

    const [rows] = await db.promise().query(
      "SELECT password FROM users WHERE id = ?",
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.promise().query("UPDATE users SET password = ? WHERE id = ?", [hashed, req.user.id]);

    res.json({ message: "Password changed successfully." });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ message: "Password update failed" });
  }
});

module.exports = router;
