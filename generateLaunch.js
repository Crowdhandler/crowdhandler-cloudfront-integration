"use strict";

// -----------------------------------------------------------------------------
// Advanced Configurables
// -----------------------------------------------------------------------------
// NODE_OPTIONS is set to use the OpenSSL legacy provider for serverless webpack.
// Change the value here if you require a different OpenSSL configuration.
process.env.NODE_OPTIONS = "--openssl-legacy-provider";

// S3 configuration - change these values if needed.
const S3_REGION = "us-east-1";
const BUCKET_NAME = "cloudfront-integration-bundles";

// Serverless package command - modify if your packaging command changes.
const SERVERLESS_CMD =
  "mv handlerViewerRequest.js handlerViewerRequest.js.base && mv handlerViewerRequest.js.garnished handlerViewerRequest.js && serverless package --package garnished_dist && mv handlerViewerRequest.js.base handlerViewerRequest.js";

// -----------------------------------------------------------------------------
// Module Imports
// -----------------------------------------------------------------------------
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: S3_REGION });
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/**
 * Executes a shell command and returns a promise that resolves with the output.
 *
 * @param {string} cmd - The command to execute.
 * @returns {Promise<{ stdout: string, stderr: string }>} - Resolves with the command output.
 */
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Uploads a single file to S3 under the specified directory (prefix).
 *
 * @param {string} filePath - The local file path of the file to upload.
 * @param {string} directory - The S3 directory (prefix) in which to store the file.
 * @returns {Promise<void>}
 */
async function uploadFileToS3(filePath, directory) {
  const fileName = path.basename(filePath);
  // Ensure the directory ends with a slash to mimic folder structure in S3.
  if (!directory.endsWith("/")) {
    directory += "/";
  }
  const key = `${directory}${fileName}`;

  // Get file statistics to determine its size.
  const stat = fs.statSync(filePath);
  const fileStream = fs.createReadStream(filePath);

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileStream,
    ContentType: "application/zip",
    ContentLength: stat.size,
  });

  try {
    await s3.send(command);
    console.log(`Successfully uploaded ${fileName} to ${BUCKET_NAME}/${key}`);
  } catch (err) {
    console.error(`Error uploading ${fileName}:`, err);
    throw err;
  }
}

/**
 * Verifies the public key by checking its format and hashing the second half with a salt.
 *
 * @param {string} key - Public Key to verify.
 * @returns {boolean|object} - Returns false if the key is invalid, otherwise returns an object with key details.
 * @throws {Error} - Throws an error if the key is not valid.
 */
function verifyPubKey(key) {
  let salt = process.env.SALT;
  let cognitoID = null;

  if (!key) {
    console.log("No key provided.");
    return false;
  }

  // Deal with invalid keys.
  if (key.length !== 64) {
    console.log("Key is not 64 characters!");
    console.log(key);
    return false;
  }

  // Get first half of the key
  const keyFirstPortion = key.slice(0, 32);
  const keySecondPortion = key.slice(32);
  // Use crypto for MD5 hashing
  const keySecondPortionSalted = crypto
    .createHash("md5")
    .update(`${keySecondPortion}${salt}`)
    .digest("hex");

  // Salted second half of the original key should match the first half
  if (keySecondPortionSalted !== keyFirstPortion) {
    console.log("Key mismatch!");
    return false;
  } else {
    // These values have been injected during the key creation process to assist with database sharding.
    return {
      cognitoID: cognitoID,
      key: key,
      shard: keySecondPortion[7],
      territory: keySecondPortion[15],
    };
  }
}

/**
 * Uploads multiple files to S3 by iterating over each file.
 *
 * @param {string[]} files - An array of local file paths to upload.
 * @param {string} directory - The S3 directory (prefix) where the files should be uploaded.
 * @returns {Promise<void>}
 */
async function uploadFiles(files, directory) {
  for (const filePath of files) {
    await uploadFileToS3(filePath, directory);
  }
}

/**
 * Retrieves the latest version of the function code from the GitHub repository.
 *
 * @returns {Promise<string>} - Resolves with the function code as a string.
 */
async function getFunctionCode() {
  const rawCodeURL =
    "https://raw.githubusercontent.com/Crowdhandler/crowdhandler-cloudfront-integration/refs/heads/master/handlerViewerRequest.js";
  const response = await axios.get(rawCodeURL);
  return response.data;
}

/**
 * Packages the garnished code using the serverless framework.
 * This function temporarily renames files to ensure correct packaging.
 *
 * @returns {Promise<string>} - Resolves with the stdout output of the packaging command.
 */
/*function serverlessPackage() {
  return new Promise((resolve, reject) => {
    exec(SERVERLESS_CMD, (err, stdout, stderr) => {
      console.log("stdout:", stdout);
      console.log("stderr:", stderr);
      if (err) {
        console.error("Error during packaging:", err);
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}*/

/**
 * Packages the garnished code using the serverless framework.
 * This function temporarily renames files to ensure correct packaging.
 * 
 * @returns {Promise<string>} - Resolves with the stdout output of the packaging command.
 */
async function serverlessPackage() {
  const orig = "handlerViewerRequest.js";
  const base = "handlerViewerRequest.js.base";
  const garnished = "handlerViewerRequest.js.garnished";

  // Rename originals → base, garnished → orig
  fs.renameSync(orig, base);
  fs.renameSync(garnished, orig);

  try {
    const { stdout, stderr } = await execPromise(
      "serverless package --package garnished_dist"
    );
    console.log("serverless stdout:", stdout);
    console.log("serverless stderr:", stderr);
    return stdout;
  } catch (e) {
    console.error("Error during serverless package:", e.stderr || e.err);
    throw e;
  } finally {
    // Always restore base → orig
    if (fs.existsSync(base)) {
      fs.renameSync(base, orig);
    }
  }
}

// -----------------------------------------------------------------------------
// Express Route Handler
// -----------------------------------------------------------------------------

/**
 * GET /generateQuickLaunchURL
 *
 * This endpoint:
 *  - Pulls down the latest function code from GitHub.
 *  - Replaces placeholders (CROWDHANDLER_PUBLIC_KEY, CROWDHANDLER_API_DOMAIN) using query parameters.
 *  - Writes the garnished code to a file.
 *  - Packages the code using the serverless framework.
 *  - Uploads the generated zip files to S3 under a key-scoped directory.
 *  - Returns a Quick Launch URL for deploying the stack via CloudFormation.
 *
 * Query Parameters:
 *  - publicKey (required): The public key used to scope the S3 directory.
 *  - apiDomain (optional): The API domain to replace in the code (default: "api.crowdhandler.com").
 *
 * @example GET /generateQuickLaunchURL?publicKey=YOUR_PUBLIC_KEY&apiDomain=your.api.domain
 */
app.get("/generateQuickLaunchURL", async (req, res) => {
  try {
    const publicKey = req.query.publicKey;
    const apiDomain = req.query.apiDomain || "api.crowdhandler.com";

    if (!publicKey) {
      return res.status(400).send("Public Key is required");
    }

    // Verify the public key.
    try {
      let keyStatus = verifyPubKey(publicKey);

      if (!keyStatus) {
        throw new Error("Invalid public key");
      }
    } catch (error) {
      console.error("Error verifying public key:", error);
      return res.status(400).send("Invalid Public Key");
    }

    // Pull down the latest version of the function code from GitHub.
    let code = await getFunctionCode();

    // Replace placeholders with actual values.
    const garnishedCode = code
      .replace("CROWDHANDLER_PUBLIC_KEY", publicKey)
      .replace("CROWDHANDLER_API_DOMAIN", apiDomain);

    // Write the modified code to a file.
    fs.writeFileSync("handlerViewerRequest.js.garnished", garnishedCode);

    // Package the garnished code using serverless.
    await serverlessPackage();

    // Upload the zip files to S3 under the path: dist/<publicKey>/*.zip
    await uploadFiles(
      [
        "garnished_dist/originOverride.zip",
        "garnished_dist/viewerRequest.zip",
        "garnished_dist/originResponse.zip",
      ],
      `dist/${publicKey}`
    );

    // Construct a Quick Launch URL for CloudFormation.
    // The CloudFormation template is hardcoded to a fixed location in our S3 bucket.
    const templateURL =
      "https://cloudfront-integration-bundles.s3.us-east-1.amazonaws.com/cloudformation.yaml";
    const quickLaunchURL = `https://console.aws.amazon.com/cloudformation/home?region=${S3_REGION}#/stacks/create/review?templateURL=${encodeURIComponent(
      templateURL
    )}&stackName=crowdhandler&param_PublicKey=${publicKey}`;

    // Return the Quick Launch URL as JSON.
    res.json({ quickLaunchURL });
  } catch (error) {
    console.error("Error generating quick launch URL:", error);
    res
      .status(500)
      .send("An error occurred while generating the quick launch URL.");
  }
});

// -----------------------------------------------------------------------------
// Start the Express Server
// -----------------------------------------------------------------------------
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

/*
--------------------------------------------------------------------------------
Documentation for Advanced Configurables:
--------------------------------------------------------------------------------
1. OpenSSL Legacy Provider:
   - The environment variable NODE_OPTIONS is set to "--openssl-legacy-provider" at
     the top of this file. Adjust this if your environment requires a different setting.

2. S3 Configuration:
   - The S3 region (S3_REGION) and bucket name (BUCKET_NAME) are defined in the
     "Advanced Configurables" section. Change these values to match your deployment.

3. Serverless Packaging:
   - The SERVERLESS_CMD constant defines the command used to package the garnished
     code. If your packaging process changes or you need additional steps, update this
     command accordingly.

4. CloudFormation Quick Launch:
   - The Quick Launch URL is constructed based on the assumption that your CloudFormation
     template is stored at a fixed location:
       https://cloudfront-integration-bundles.s3.us-east-2.amazonaws.com/cloudformation.yaml
   - The S3 uploads will be placed in a folder named "dist/<publicKey>/".
   - The CloudFormation template itself is parameterized to use the dynamic publicKey for
     function code locations.
   
5. Changing Placeholders:
   - The placeholders "CROWDHANDLER_PUBLIC_KEY" and "CROWDHANDLER_API_DOMAIN" in the
     fetched code are replaced with values provided via query parameters. Update the
     replacement logic if additional placeholders are introduced.

This code is structured for public consumption with clear separation of concerns,
extensive inline documentation, and easy-to-modify advanced settings.
--------------------------------------------------------------------------------
*/
