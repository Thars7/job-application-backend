require('dotenv').config(); 

const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const nodemailer = require('nodemailer');
const nlp = require('compromise'); 

const app = express();

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN, 
  methods: ['GET', 'POST', 'OPTIONS'], 
  allowedHeaders: ['Content-Type', 'Authorization'], 
  credentials: true, 
}));

// Handle preflight requests
app.options('*', cors()); 

// Configure multer to handle files in memory
const upload = multer({ storage: multer.memoryStorage() });

// AWS S3 Configuration (v3)
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// Google Sheets API Configuration
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SHEETS_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Extract text from PDF
async function extractTextFromPDF(filePath) {
  try {
    const dataBuffer = await fs.promises.readFile(filePath);
    const data = await pdf(dataBuffer);
    return data.text; 
  } catch (error) {
    console.error('Error extracting text from PDF:', error);
    return ''; 
  }
}

// Extract text from DOCX
async function extractTextFromDOCX(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value; 
  } catch (error) {
    console.error('Error extracting text from DOCX:', error);
    return ''; 
  }
}

// Upload file to S3 (v3)
async function uploadToS3(filePath, fileName) {
  const fileContent = await fs.promises.readFile(filePath);
  const params = {
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: fileContent,
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
    Thank you for submitting your application. We have successfully received your CV and our team is currently reviewing your qualifications.

    We will get back to you soon regarding the next steps. If you have any questions, feel free to reply to this email.
    
    Best regards,  
    Tharsa S.`, 
    html: `
    <p>Dear ${senderName},</p>
    <p>Thank you for submitting your application. We have successfully received your CV and our team is currently reviewing your qualifications.</p>
    <p>We will get back to you soon regarding the next steps. If you have any questions, feel free to reply to this email.</p>
    <br>
    <p>Best regards,</p>
    <p><strong>Tharsa S.</strong></p>
    `, 
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('Email sent successfully to:', email);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Extract personal info using NLP
function extractPersonalInfo(text) {
  const doc = nlp(text);

  let name = "";
  let email = "";
  let phone = "";

  // **Extract Name** (with or without label)
  const nameRegex = /(Name|NAME)?\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i;
  const nameMatch = text.match(nameRegex);
  if (nameMatch) {
    name = nameMatch[2].trim();
  } else {
    // NLP fallback for names (if regex fails)
    const personMatch = doc.match('#Person').out('text');
    if (personMatch) {
      name = personMatch.trim();
    } else {
      // Assume the first line as a fallback
      const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      name = lines[0];
    }
  }

  // Extract Email (with or without label)
  const emailRegex = /(Email|EMAIL)?\s*[:\-]?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
  const emailMatch = text.match(emailRegex);
  if (emailMatch) {
    email = emailMatch[2].trim();
  } else {
    // Fallback: Search for email without label
    const emailFallback = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (emailFallback) {
      email = emailFallback[0].trim();
    }
  }

  // Extract Phone Number (with or without label)
  const phoneRegex = /(Phone Number|Phone number|Contact Number|Contact number|Contact|CONTACT|Phone|PHONE)?\s*[:\-]?\s*(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/i;
  const phoneMatch = text.match(phoneRegex);
  if (phoneMatch) {
    phone = phoneMatch[0].replace(/(Phone Number|Phone number|Contact Number|Contact number|Contact|CONTACT|Phone|PHONE)[:\-]?\s*/i, '').trim();
  } else {
    // Fallback: Search for phone number without label
    const phoneFallback = text.match(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/i);
    if (phoneFallback) {
      phone = phoneFallback[0].trim();
    }
  }

  return { name, email, phone };
}

// Extract education using NLP
function extractEducation(text) {
  const doc = nlp(text);

  // Match different education-related terms using NLP
  const educationMatches = [
    ...doc.match('#Education').out('array'),
    ...doc.match('Education|Educations|EDUCATION|EDUCATIONS|Academic Background|ACADEMIC BACKGROUND').out('array')
  ];

  // Remove duplicates
  const uniqueEducation = [...new Set(educationMatches)];

  // Fallback to regex if NLP doesn't find anything
  if (uniqueEducation.length === 0) {
    const educationRegex = /(Education|Educations|EDUCATION|EDUCATIONS|Academic Background|ACADEMIC BACKGROUND)\s*([\s\S]*?)(?=Skills|Projects|Qualifications|$)/i;
    const match = text.match(educationRegex);
    if (match) {
      return match[2].trim().split('\n').map(line => line.trim()).filter(entry => entry.length > 0);
    }
  }

  return uniqueEducation;
}

// Extract skills using NLP
function extractSkills(text) {
  const doc = nlp(text);

  // Match different skills-related terms using NLP
  const skillsMatches = [
    ...doc.match('#Skill').out('array'),
    ...doc.match('Skill|Skills|SKILL|SKILLS|Technical Skill|Technical Skills|TECHNICAL SKILL|TECHNICAL SKILLS|Qualifications|QUALIFICATIONS').out('array')
  ];

  // Remove duplicates
  const uniqueSkills = [...new Set(skillsMatches)];

  // Fallback to regex if NLP doesn't find anything
  if (uniqueSkills.length === 0) {
    const skillsRegex = /(Skill|Skills|SKILL|SKILLS|Technical Skill|Technical Skills|TECHNICAL SKILL|TECHNICAL SKILLS|Qualifications|QUALIFICATIONS)\s*([\s\S]*?)(?=Projects|Education|$)/i;
    const match = text.match(skillsRegex);
    if (match) {
      return match[2].trim().split('\n').map(line => line.trim()).filter(skill => skill.length > 0);
    }
  }

  return uniqueSkills;
}


// Extract projects using NLP
function extractProjects(text) {
  const doc = nlp(text);

  // Match different project-related terms using NLP
  const projectMatches = [
    ...doc.match('#Project').out('array'),
    ...doc.match('Project|Projects|PROJECT|PROJECTS|Work Experience|WORK EXPERIENCE').out('array')
  ];

  // Remove duplicates
  const uniqueProjects = [...new Set(projectMatches)];

  // Fallback to regex if NLP doesn't find anything
  if (uniqueProjects.length === 0) {
    const projectsRegex = /(Project|Projects|PROJECT|PROJECTS|Work Experience|WORK EXPERIENCE)\s*([\s\S]*?)(?=Education|Skills|Qualifications|$)/i;
    const match = text.match(projectsRegex);
    if (match) {
      return match[2].trim().split('\n').map(line => line.trim()).filter(project => project.length > 0);
    }
  }

  return uniqueProjects;
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

// Submit endpoint
app.post('/submit', upload.single('cv'), async (req, res) => {
  const { name, email, phone } = req.body;
  const file = req.file;

  try {
    // Extract text from CV
    const filePath = file.path;
    const fileExtension = file.originalname.split('.').pop();
    let text = '';
    if (fileExtension === 'pdf') {
      text = await extractTextFromPDF(filePath);
    } else if (fileExtension === 'docx') {
      text = await extractTextFromDOCX(filePath);
    } else {
      throw new Error('Unsupported file format. Only PDF and DOCX are allowed.');
    }

    // Extract sections from the CV text using NLP
    const personalInfo = extractPersonalInfo(text);
    const education = extractEducation(text);
    const skills = extractSkills(text);
    const projects = extractProjects(text);

    // Upload CV to S3
    const publicUrl = await uploadToS3(filePath, file.originalname);

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

    // Send email
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