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
        skillsRequired = [],
        requirements = [],      // New field for job requirements
        responsibilities = []   // New field for job responsibilities
    } = req.body;

    // Validate required fields
    if (
        !title || !description || !location || !jobType ||
        !applicationDeadline || !jobStartDate || !price || !postedBy
    ) {
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
            skillsRequired,         // Store the skills array
            requirements,           // Store the requirements array
            responsibilities,       // Store the responsibilities array
            createdAt: new Date().toISOString(),
        });

        res.status(201).json({
            message: 'Job posted successfully',
            jobId: jobRef.id
        });
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
        skillsRequired,
        requirements,
        responsibilities
    } = req.body;

    // Validate the required fields
    if (!title || !description || !location || !jobType || !applicationDeadline || !jobStartDate || price === undefined) {
        return res.status(400).json({ message: 'Required fields are missing.' });
    }

    try {
        const jobRef = db.collection('jobs').doc(jobId);
        const jobSnapshot = await jobRef.get();

        // Check if the job exists in the database
        if (!jobSnapshot.exists) {
            return res.status(404).json({ message: 'Job not found' });
        }

        // Prepare the update data
        const updateData = {
            title,
            description,
            location,
            jobType,
            applicationDeadline,
            jobStartDate,
            price: parseFloat(price), // Ensure price is a number
            negotiable,
            updatedAt: new Date().toISOString(), // Add timestamp for when job was last updated
        };

        // Add optional fields if they exist
        if (expectedEndDate) {
            updateData.expectedEndDate = expectedEndDate;
        }

        if (skillsRequired && Array.isArray(skillsRequired)) {
            updateData.skillsRequired = skillsRequired;
        }

        if (requirements && Array.isArray(requirements)) {
            updateData.requirements = requirements;
        }

        if (responsibilities && Array.isArray(responsibilities)) {
            updateData.responsibilities = responsibilities;
        }

        // Update the job document with the new data
        await jobRef.update(updateData);

        res.status(200).json({
            message: 'Job updated successfully',
            updatedFields: Object.keys(updateData)
        });
    } catch (error) {
        console.error('Error updating job:', error);
        res.status(500).json({ message: 'Failed to update job' });
    }
});

// Also, you might want to update your GET route to return the new fields
router.get('/:jobId', async (req, res) => {
    const { jobId } = req.params;

    try {
        const jobRef = db.collection('jobs').doc(jobId);
        const jobSnapshot = await jobRef.get();

        if (!jobSnapshot.exists) {
            return res.status(404).json({ message: 'Job not found' });
        }

        const jobData = jobSnapshot.data();

        res.status(200).json({
            job: {
                id: jobSnapshot.id,
                ...jobData,
                // Ensure arrays exist even if not set in database
                skillsRequired: jobData.skillsRequired || [],
                requirements: jobData.requirements || [],
                responsibilities: jobData.responsibilities || []
            }
        });
    } catch (error) {
        console.error('Error fetching job:', error);
        res.status(500).json({ message: 'Failed to fetch job' });
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
