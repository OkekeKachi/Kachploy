// Assuming you are using Express.js and Firebase Firestore (or similar DB)
const express = require('express');
const router = express.Router();
const { admin, db } = require("../config/firebase");

// Route to create a task
router.post('/', async (req, res) => {
    const { jobId, employeeId, taskName, taskDescription, dueDate } = req.body;

    if (!jobId || !employeeId || !taskName || !taskDescription || !dueDate) {
        return res.status(400).json({ message: 'Missing required fields' });
    }

    try {
        // Create a new task in the 'tasks' collection
        const taskRef = await db.collection('tasks').add({
            jobId,
            employeeId,
            taskName,
            taskDescription,
            dueDate,
            createdDate: new Date(),
        });

        // Return the created task's ID
        res.status(200).json({ message: 'Task created successfully', taskId: taskRef.id });
    } catch (error) {
        console.error('Error creating task:', error);
        res.status(500).json({ message: 'Failed to create task' });
    }
});

module.exports = router;
