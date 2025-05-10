var express = require('express');
var router = express.Router();
const { admin, db } = require("../config/firebase");

router.get('/', async (req, res) => {
    try {
        const snapshot = await db.collection('jobs').get();
        const jobs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json({ jobs });
    } catch (err) {
        console.error('Error fetching jobs:', err);
        res.status(500).json({ message: 'Failed to fetch jobs' });
    }
});

router.post('/create', async (req, res) => {
    const {
        title,
        description,
        location,
        jobType,
        applicationDeadline,
        jobStartDate,
        expectedEndDate,
        price,
        negotiable,
        postedBy,
        status = 'open',
        skillsRequired = [] // <-- new field
    } = req.body;

    if (
        !title || !description || !location || !jobType ||
        !applicationDeadline || !jobStartDate || !price || !postedBy
    ){
        return res.status(400).json({ message: 'Missing required fields' });
    }

    try {
        const jobRef = db.collection('jobs').doc();
        const proposal = 0;
        await jobRef.set({
            title,
            description,
            location,
            jobType,
            applicationDeadline,
            jobStartDate,
            expectedEndDate: expectedEndDate || null,
            price,
            negotiable,
            status,
            postedBy,
            proposal,
            skillsRequired, // <-- store the array
            createdAt: new Date().toISOString(),
        });

        res.status(201).json({ message: 'Job posted successfully' });
    } catch (err) {
        console.error('Error posting job:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});



router.get('/employer/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        const jobsSnapshot = await db.collection('jobs').where('postedBy', '==', uid).get();


        if (jobsSnapshot.empty) {
            console.log("nothing here");
            return res.status(200).json({ jobs: [] });


        }

        const jobs = [];
        jobsSnapshot.forEach(doc => {
            jobs.push({ id: doc.id, ...doc.data() });
        });
        console.log(jobs);

        res.status(200).json({ jobs });
    } catch (error) {
        console.error('Error fetching employer jobs:', error);
        res.status(500).json({ message: 'Failed to fetch jobs' });
    }
});

router.get('/:jobId', async (req, res) => {
    const { jobId } = req.params;

    try {
        const jobRef = db.collection('jobs').doc(jobId);
        const jobSnapshot = await jobRef.get();

        if (!jobSnapshot.exists) {
            return res.status(404).json({ message: 'Job not found' });
        }

        const job = jobSnapshot.data();
        res.status(200).json({ job });
    } catch (error) {
        console.error('Error fetching job:', error);
        res.status(500).json({ message: 'Failed to fetch job' });
    }
});

router.put('/edit/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const { title, description, location, jobType, applicationDeadline, startDate, endDate, price, isNegotiable } = req.body;

    // Validate the fields to ensure they are provided in the request body
    if (!title || !description || !location || !jobType || !applicationDeadline || !startDate || !endDate || price === undefined) {
        return res.status(400).json({ message: 'All fields are required.' });
    }

    try {
        const jobRef = db.collection('jobs').doc(jobId);
        const jobSnapshot = await jobRef.get();

        // Check if the job exists in the database
        if (!jobSnapshot.exists) {
            return res.status(404).json({ message: 'Job not found' });
        }

        // Update the job document with the new data
        await jobRef.update({
            title,
            description,
            location,
            jobType,
            applicationDeadline,
            startDate,
            endDate,
            price,
            isNegotiable
        });

        res.status(200).json({ message: 'Job updated successfully' });
    } catch (error) {
        console.error('Error updating job:', error);
        res.status(500).json({ message: 'Failed to update job' });
    }
});


router.delete('/:jobId', async (req, res) => {
    const { jobId } = req.params;

    try {
        const jobRef = db.collection('jobs').doc(jobId);
        const jobSnapshot = await jobRef.get();

        if (!jobSnapshot.exists) {
            return res.status(404).json({ message: 'Job not found' });
        }

        // Delete the job document
        await jobRef.delete();

        return res.status(200).json({ message: 'Job deleted successfully' });
    } catch (error) {
        console.error('Error deleting job:', error);
        res.status(500).json({ message: 'Failed to delete job' });
    }
});
// PUT /jobs/:jobId/status
router.put('/:jobId/status', async (req, res) => {
    const { jobId } = req.params;
    const { status } = req.body;

    try {
        await db.collection('jobs').doc(jobId).update({ status });
        res.status(200).json({ message: 'Job status updated' });
    } catch (err) {
        res.status(500).json({ message: 'Failed to update job status' });
    }
});


module.exports = router;
