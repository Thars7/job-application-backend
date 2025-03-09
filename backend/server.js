require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const cors = require('cors');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const nodemailer = require('nodemailer');

const app = express();

app.use(cors({
  origin: 'https://job-application-sigma-wine.vercel.app', 
  methods: ['GET', 'POST', 'OPTIONS'], 
  allowedHeaders: ['Content-Type', 'Authorization'], 
  credentials: true, 
}));

// Handle preflight requests
app.options('*', cors()); 

// Configure multer to handle files in memory
const upload = multer({ storage: multer.memoryStorage() });

app.get('/',(req,res) => {
  res.send("hello world!!!")
})

// AWS S3 Configuration (v3)
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const credentials = JSON.parse(process.env.GOOGLE_SHEETS_KEY_FILE);

// Google Sheets Configuration
const auth = new google.auth.GoogleAuth({
  keyFile: credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Extract text from PDF
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text; 
  } catch (error) {
    console.error('Error extracting text from PDF:', error);
    return ''; 
  }
}

// Extract text from DOCX
async function extractTextFromDOCX(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value; 
  } catch (error) {
    console.error('Error extracting text from DOCX:', error);
    return ''; 
  }
}

// Upload file to S3 (v3)
async function uploadToS3(buffer, fileName) {
  const params = {
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ACL: 'public-read',
  };
  const command = new PutObjectCommand(params);
  await s3Client.send(command);
  return `https://${BUCKET_NAME}.s3.amazonaws.com/${fileName}`;
}

// Store data in Google Sheets
async function storeInGoogleSheets(data) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Sheet1', 
    valueInputOption: 'RAW',
    resource: { values: [data] },
  });
}

// Send email using Nodemailer
async function sendEmail(email) {
  const senderName = "Applicant";
  const transporter = nodemailer.createTransport({
    service: 'gmail', 
    auth: {
      user: process.env.EMAIL_USER, 
      pass: process.env.EMAIL_PASS, 
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER, 
    to: email,
    subject: 'Application Received – Your CV is Under Review',
    text: `Dear ${senderName},
    'Thank you for submitting your application. We have successfully received your CV and our team is currently reviewing your qualifications.

    We will get back to you soon regarding the next steps. If you have any questions, feel free to reply to this email.'
    
    Best regards,  
    Tharsa S.'`, 
    html: `
    '<p>Dear ${senderName},</p>
    <p>Thank you for submitting your application. We have successfully received your CV and our team is currently reviewing your qualifications.</p>
    <p>We will get back to you soon regarding the next steps. If you have any questions, feel free to reply to this email.</p>
    <br>
    <p>Best regards,</p>
    <p><strong>Tharsa S.</strong></p>'
    `, 
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Email sent successfully to:', email);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Extract personal info (name, email, phone)
function extractPersonalInfo(text) {
  const nameRegex = /(?:Name|NAME)\s*[:-]?\s*(.*)/i;
  let name = text.match(nameRegex)?.[1]?.trim() || '';

  if (!name) {
    const lines = text.split('\n').map(line => line.trim());
    if (lines.length > 0) {
      name = lines[0]; // Assume the first line is the name
    }
  }

  const emailRegex = /(?:Email|EMAIL)\s*[:-]?\s*(.*)/i;
  const email = text.match(emailRegex)?.[1]?.trim() || '';

  const phoneRegex = /(?:Phone|PHONE)\s*[:-]?\s*(.*)/i;
  const phone = text.match(phoneRegex)?.[1]?.trim() || '';

  return { name, email, phone };
}

// Extract education
function extractEducation(text) {
  const educationRegex = /(Education|Educations|EDUCATION|EDUCATIONS)\s*([\s\S]*?)(?=Skills|Projects|Qualifications|$)/i;
  const match = text.match(educationRegex);
  if (!match) return [];

  const educationEntries = match[1].trim().split('\n').map(line => line.trim());
  return educationEntries.filter(entry => entry.length > 0);
}

// Extract skills
function extractSkills(text) {
  const skillsRegex = /(Skill|Skills|SKILL|SKILLS|Qualifications)\s*([\s\S]*?)(?=Projects|Education|$)/i;
  const match = text.match(skillsRegex);
  if (!match) return [];

  const skills = match[2].trim().split('\n').map(line => line.trim());
  return skills.filter(skill => skill.length > 0);
}

// Extract projects
function extractProjects(text) {
  const projectsRegex = /(Project|Projects|PROJECT|PROJECTS)\s*([\s\S]*?)(?=Education|Skills|Qualifications|$)/i;
  const match = text.match(projectsRegex);
  if (!match) return [];

  const projects = match[1].trim().split('\n').map(line => line.trim());
  return projects.filter(project => project.length > 0);
}

// Send HTTP request to webhook
async function sendWebhook(email, cvData, publicUrl, education, skills, projects) {
  const webhookUrl = process.env.WEBHOOK_URL;
  const payload = {
    cv_data: {
      personal_info: {
        name: cvData.name,
        email: cvData.email,
        phone: cvData.phone,
      },
      education: education,
      skills: skills,
      projects: projects,
      cv_public_link: publicUrl,
    },
    metadata: {
      applicant_name: cvData.name,
      email: cvData.email,
      status: 'prod', 
      cv_processed: true,
      processed_timestamp: new Date().toISOString(),
    },
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Candidate-Email': email,
    },
    body: JSON.stringify(payload),
  });

  return response.ok;
}

app.post('/submit', upload.single('cv'), async (req, res) => {
  const { name, email, phone } = req.body;
  const file = req.file;

  try {
    // Extract text from CV
    const buffer = file.buffer;
    const fileExtension = file.originalname.split('.').pop();
    let text = '';
    if (fileExtension === 'pdf') {
      text = await extractTextFromPDF(buffer);
    } else if (fileExtension === 'docx') {
      text = await extractTextFromDOCX(buffer);
    }

    // Extract sections from the CV text
    const personalInfo = extractPersonalInfo(text);
    const education = extractEducation(text);
    const skills = extractSkills(text);
    const projects = extractProjects(text);

    const publicUrl = await uploadToS3(buffer, file.originalname);

    // Store data in Google Sheets
    await storeInGoogleSheets([
      personalInfo.name || name, 
      personalInfo.email || email, 
      personalInfo.phone || phone, 
      publicUrl, 
      education.join('\n'), 
      skills.join('\n'), 
      projects.join('\n'), 
    ]);

    // Send email using Nodemailer
    await sendEmail(email);

    // Send webhook
    const cvData = {
      name: personalInfo.name || name,
      email: personalInfo.email || email,
      phone: personalInfo.phone || phone,
    };
    await sendWebhook(email, cvData, publicUrl, education, skills, projects);

    res.json({ message: 'Application submitted successfully!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error processing application.' });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server is running on job-application-backend-xo8s.vercel.app:${PORT}`);
});