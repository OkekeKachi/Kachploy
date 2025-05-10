var express = require('express');
var router = express.Router();
const { admin, db } = require("../config/firebase");


router.post('/apply', async (req, res) => {
    const { jobId, employeeId, fullName, message, employeePrice, proposal } = req.body;
    const proposals = proposal - 1;
    if (!jobId || !employeeId) {
        return res.status(400).json({ message: 'Missing required fields' });
    }

    try {
        // Get the job from the database to check if it is negotiable
        const jobRef = db.collection('jobs').doc(jobId);
        const jobSnapshot = await jobRef.get();

        if (!jobSnapshot.exists) {
            return res.status(404).json({ message: 'Job not found' });
        }

        const jobData = jobSnapshot.data();

        // If the job is negotiable, store the employee's requested price
        if (jobData.isNegotiable && employeePrice != null) {
            // Optionally, validate the employee price, e.g., check if it's greater than 0
            if (employeePrice <= 0) {
                return res.status(400).json({ message: 'Invalid price. It must be greater than 0.' });
            }
        } else if (jobData.isNegotiable === false && employeePrice != null) {
            // If the job is not negotiable, reject the price field
            return res.status(400).json({ message: 'This job is not negotiable, price cannot be provided.' });
        }
        
        // Add application data
        await db.collection('applications').add({
            jobId,
            employeeId,
            fullName,
            message: message || '',
            employeePrice: jobData.isNegotiable ? employeePrice : null, // Only store employeePrice if the job is negotiable
            dateApplied: new Date(),
            status: "pending",
            proposals
        });

        res.status(200).json({ message: 'Application submitted successfully' });
    } catch (error) {
        console.error('Error applying for job:', error);
        res.status(500).json({ message: 'Failed to apply' });
    }
});


router.get('/employee/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        const snapshot = await db.collection('applications').where('employeeId', '==', uid).get();

        const applications = [];

        for (const doc of snapshot.docs) {
            const data = doc.data();

            // Fetch job details too
            const jobDoc = await db.collection('jobs').doc(data.jobId).get();
            const jobData = jobDoc.exists ? jobDoc.data() : null;

            applications.push({
                id: doc.id,
                ...data,
                job: jobData,
            });
        }
        console.log(applications);

        res.status(200).json({ applications });
    } catch (error) {
        console.error('Error fetching applications:', error);
        res.status(500).json({ message: 'Failed to fetch applications' });
    }
});

router.get('/job/:jobId', async (req, res) => {
    const { jobId } = req.params;

    try {
        const snapshot = await db.collection('applications')
            .where('jobId', '==', jobId)
            .get();

        const applications = [];

        snapshot.forEach(doc => {
            applications.push({ id: doc.id, ...doc.data() });
        });

        res.status(200).json({ applications });
    } catch (error) {
        console.error('Error fetching applications for job:', error);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});



router.put('/:id/status', async (req, res) => {
    try {
        const applicationId = req.params.id;
        const newStatus = req.body.status;

        if (!newStatus) return res.status(400).json({ message: 'Status is required' });

        const applicationRef = db.collection('applications').doc(applicationId);
        await applicationRef.update({ status: newStatus });
        console.log("heyyy");

        res.status(200).json({ message: 'Status updated successfully' });
    } catch (err) {
        console.log("not working");
        res.status(500).json({ message: 'Failed to update status', error: err.message });
    }
});

router.delete('/:applicationId', async (req, res) => {
    const { applicationId } = req.params;

    try {
        const appRef = db.collection('applications').doc(applicationId);
        const appSnap = await appRef.get();

        if (!appSnap.exists) {
            return res.status(404).json({ message: 'Application not found' });
        }

        const { jobId } = appSnap.data();

        // Decrement the proposals field on the job
        const jobRef = db.collection('jobs').doc(jobId);
        await jobRef.update({
            proposals: admin.firestore.FieldValue.increment(-1),
        });

        // Delete the application
        await appRef.delete();

        res.status(200).json({ message: 'Application withdrawn successfully' });
    } catch (error) {
        console.error('Error withdrawing application:', error);
        res.status(500).json({ message: 'Failed to withdraw application' });
    }
});


// Route to create a task for the hired applicant
router.post('/tasks', async (req, res) => {
    const { jobId, employeeId, taskName, taskDescription, dueDate } = req.body;

    try {
        // Adding the new task to the 'tasks' collection
        await db.collection('tasks').add({
            jobId,
            employeeId,
            taskName,
            taskDescription,
            dueDate,
            createdDate: new Date(),
        });
        res.status(200).json({ message: 'Task created successfully' });
    } catch (error) {
        console.error('Error creating task:', error);
        res.status(500).json({ message: 'Failed to create task' });
    }
});



module.exports = router;
