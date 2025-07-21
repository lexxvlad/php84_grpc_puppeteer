import puppeteer from 'puppeteer-extra';
import Stealth from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

puppeteer.use(Stealth());

const pageUrl = process.argv[2];
const targetRequestPart = process.argv[3];
const passedCookies = JSON.parse(process.argv[4]);
const devDir = process.argv[5] ? process.argv[5] : '';
const capmonsterKey = process.env.CAPMONSTER_KEY;
console.log('CAPMONSTER_KEY: ' + capmonsterKey);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const captcha_metadata_file = 'captcha_metadata.json';
const img_captcha_try_limit = 5;
let page = null;
let client = null;
let customUA = null;

async function getActualUA() {
	let customUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
	const getAgent = await axios.get('https://capmonster.cloud/api/useragent/actual');
	if (getAgent.data) {
		customUA = getAgent.data;
	}
	return customUA;
}

async function findFrameWithSelectorRecursively(frames, selectorStr, timeoutMs = 1500) {
	for (const frame of frames) {
		let frameHtml = await frame.content();
		//console.log(frameHtml);
		try {	
			//await fs.writeFile(`${devDir}/text/frame-${timestamp}.html`, frameHtml);
		} catch (e) {
			console.warn('failed to save frame content: ', e.message);
		}
		try {
			let selector = await frame.waitForSelector(selectorStr, {timeout: timeoutMs});		
			return {frame, selector};
		} catch (e) {
		}
		let childResult = await findFrameWithSelectorRecursively(frame.childFrames(), selectorStr, timeoutMs);
		if (childResult) {
			return childResult;
		}
	}
	return null;
}

async function frameSiteKey(frame) {
	const frameHtml = await frame.content();
	let match = null;
	if (match = frameHtml.match(/sitekey:"(.+?)"/)) {
		return match[1];
	}
	return null;
}

async function screenshot(name) {
	if (devDir) {
		await page.screenshot({ path: `${devDir}/screens/${name}-${timestamp}.png` });	   
		//await page.screenshot({ path: `${devDir}/screens/${name}-${timestamp}.png`, fullPage: true });	
	}
}

async function userClick(source, selectorStr = null) {
	const delayStartMs = Math.floor(Math.random() * (50) + 5);
	const delayPressMs = Math.floor(Math.random() * (50) + 5);
	const offsetX = Math.floor(Math.random() * (20) - 10);
	const offsetY = Math.floor(Math.random() * (20) - 10);
	const clickOptions = {offset: {x: offsetX, y: offsetY}, delay: delayPressMs};
	await page.waitForTimeout(delayStartMs);
	if (selectorStr) {
		await source.click(selectorStr, clickOptions);	
	} else {
		await source.click(source, clickOptions);
	}
}

async function getElementsAttributeValue(source, selectorStr, attributeName) {
	let arr = [];
	let allElements = await source.$$(selectorStr);
	for (let ind = 0; ind < allElements.length; ++ind) {
		arr.push(await allElements[ind].evaluate((el, attributeName) => el.getAttribute(attributeName), attributeName));
	}
	return arr;
}

function getChangedPositions(newArr, oldArr) {
	let arr = [];
	for (let i = 0; i < newArr.length; ++i) {
		if (newArr[i] !== oldArr[i]) {
			arr.push(i);
		}
	}
	return arr;
}

async function solveComplexImageRecaptcha() {
	const captchaMetadaObject = JSON.parse(await fs.readFile(captcha_metadata_file));
	const url = await page.url();
	let result = null;
	let i = 0;
	while (result = await findFrameWithSelectorRecursively(page.frames(), 'div#rc-imageselect')) {
		i++;
		if (i > img_captcha_try_limit) {
			throw new Error('captcha not solved, attempt limit');
		}
		await screenshot(`imageCaptcha_${i}`);
		let inputFrame = result.frame;
		let frameCaptcha = result.selector;
		if (await frameCaptcha.$('div[class^="rc-imageselect-error"][tabindex]')) {
			throw new Error('Wrong solution');
		}
		let captchaTitle = await inputFrame.evaluate(el => el.textContent, frameCaptcha);
		let taskDefinition = null;
		for (var key in captchaMetadaObject) {
			let re = new RegExp(key);
			let match = null;
			if (match = captchaTitle.match(re)) {
				taskDefinition = captchaMetadaObject[key];
				console.log('Found captcha with images:', taskDefinition + ' (' + match[0] + ')');
				break;
			}
		}
		if ( ! taskDefinition) {
			throw new Error('Unknown image captha title:', captchaTitle);
		}
		
		let imagesUrl = await getElementsAttributeValue(frameCaptcha, 'img', 'src');
		console.log('Captcha image:', imagesUrl[0]);
		let targets = await frameCaptcha.$$('.rc-image-tile-target');
		let gridSize = Math.sqrt(targets.length);
		console.log('Captcha grid:', gridSize + 'x' + gridSize);
		let capMonsterTask = {
			type: 'ComplexImageTask',
			"class": 'recaptcha',
			imageUrls: [imagesUrl[0]],
			metadata: {
				Grid: gridSize + 'x' + gridSize,
				TaskDefinition: taskDefinition
			},
			websiteURL: url,
			userAgent: customUA				
		};
		let capmonsterSolution = await executeCapmonterTask(capMonsterTask);
		if ( ! capmonsterSolution) {
			throw new Error('captcha not solved');
		}
		let clickList = capmonsterSolution.answer;
		console.log('Images to click:', clickList);	
		for (let position = 0; position < clickList.length; ++position) {
			if (clickList[position]) {
				await userClick(targets[position]);
			}
		}
		await screenshot(`imageCaptcha_${i}_click`);
		await page.waitForTimeout(7000);	
		let j = 0;
		do {
			j++;
			if (j > img_captcha_try_limit) {
				throw new Error('captcha not solved, attempt limit');
			}
			await screenshot(`imageCaptcha_${i}__${j}`);
			let imagesUrlNew = await getElementsAttributeValue(frameCaptcha, 'img', 'src');
			targets = await frameCaptcha.$$('.rc-image-tile-target');
			let changedPositions = getChangedPositions(imagesUrlNew, imagesUrl);
			console.log('changedPositions', changedPositions);
			if ( ! changedPositions.length) {
				break;
			}
			for (let k = 0; k < changedPositions.length; ++k) {
				let capMonsterTask = {
					type: 'ComplexImageTask',
					"class": 'recaptcha',
					imageUrls: [imagesUrlNew[changedPositions[k]]],
					metadata: {
						Grid: '1x1',
						TaskDefinition: taskDefinition
					},
					websiteURL: url,
					userAgent: customUA				
				};
				let capmonsterSolution = await executeCapmonterTask(capMonsterTask);
				if ( ! capmonsterSolution) {
					throw new Error('captcha not solved');
				}
				changedPositions[k] = [changedPositions[k], capmonsterSolution.answer[0]];
			}
			console.log('New Images to click:', changedPositions);	
			let needClick = false;
			for (let k = 0; k < changedPositions.length; ++k) {
				if (changedPositions[k][1]) {
					needClick = true;
					await userClick(targets[changedPositions[k][0]]);
				}
			}
			if (needClick) {
				await screenshot(`imageCaptcha_${i}__${j}_click`);
				await page.waitForTimeout(10000);
			}
			imagesUrl = imagesUrlNew;
			
		} while (true);
		let btn = await frameCaptcha.$('button#recaptcha-verify-button');
		await userClick(btn);
		await page.waitForTimeout(5000);
	}
}

async function executeCapmonterTask(capMonsterTask) {
	const postData = {
		clientKey: capmonsterKey,
		task: capMonsterTask
	};
	//console.log(JSON.stringify(postData));
	//process.exit(1);
	const taskRes = await axios.post('https://api.capmonster.cloud/createTask', postData);
	if ( ! taskRes.data) {
		return null;
	}
	const taskId = taskRes.data.taskId;
	let solution = null;
	for (let i = 0; i < 30; i++) {
		const poll = await axios.post('https://api.capmonster.cloud/getTaskResult', {
			clientKey: capmonsterKey,
			taskId
		});
		if (poll.data.status === 'ready') {
			solution = poll.data.solution;
			break;
		}
		await new Promise(r => setTimeout(r, 3000));
	}	
	return solution;
}


//not finished
async function solveRecaptchaV2Enterprise(initFrame) {
	const siteKey  = await frameSiteKey(initFrame);
	if ( ! siteKey) {
		throw new Error('siteKey not found');
	}
	console.log('siteKey:', siteKey);
	const cookiesBefore = (await client.send('Storage.getCookies')).cookies;
	const cookiesValues = cookiesBefore.map(item => item.name + '=' + item.value);
	const cookiesString = cookiesValues.join('; ');
	const url = await page.url();
	const capMonsterTask = {
			//enterprisePayload: {
				//s: payLoad
			//},				
			//type: 'RecaptchaV2EnterpriseTask',
			//proxyType: 'http',
			//proxyAddress: '46.72.191.84',
			//proxyPort: 8080,
			type: 'RecaptchaV2EnterpriseTaskProxyless',
			websiteURL: url,
			websiteKey: siteKey,
			userAgent: customUA,				
			cookies: cookiesString,
			nocache: true,		
		};
	const capmonsterSolution = await executeCapmonterTask(capMonsterTask);
	if ( ! capmonsterSolution) {
		throw new Error('captcha not solved');
	}
	const token = capmonsterSolution.gRecaptchaResponse;
	console.log('g-recaptcha-response: ' + token);
	await screenshot('before captcha solve');
	const result = await initFrame.evaluate(token => {
		//document.querySelector('textarea#g-recaptcha-response').value = token;
		if (typeof __recaptchaValidateCB__ !== "undefined") {
			__recaptchaValidateCB__(token);
			return 'good';
		}
		return 'bad';
	}, token);
	console.log('send token', result);
	await page.waitForTimeout(3000);
	//await page.waitForNavigation({ waitUntil: 'networkidle2' });
	throw new Error('not Available');
}

(async () => {
	const browser = await puppeteer.launch({
		headless: 'new',  
		IgnoreHTTPSErrors: true,
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-gpu',
			'--single-process',
			//'--proxy-server=192.168.0.112:8080',
			'--ignore-certificate-errors-spki-list',
			'--ignore-certificate-errors',
			//'--disable-features=site-per-process',
		]
	});
	page = await browser.newPage();
	await page.setViewport({
		width: 1280,
        height: 1024
    });
	//page.setCacheEnabled(false);
	console.log('Chrome version: ', await page.browser().version());
	client = await page.target().createCDPSession();
	if ( ! customUA) {
		customUA = await getActualUA();
	}
	await page.setUserAgent(customUA);
	if (passedCookies.length > 0) {
		await page.setCookie(...passedCookies);
	}
	let capturedResponse = null;
	page.on('response', async (response) => {
		const url = response.url();
		if (targetRequestPart && url.includes(targetRequestPart)) {
			try {
				const body = await response.text();
				capturedResponse = {
					url,
					body
				};
			} catch (e) {}
		}
	});
	try {
		await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
		console.log('Page url:', await page.url());
		await screenshot('BEGIN');
		await page.waitForTimeout(30000); // подождать, чтобы капча успела подгрузиться		
		const result = await findFrameWithSelectorRecursively(page.frames(), 'textarea#g-recaptcha-response');
		if (result) {
			await screenshot('initial_captcha');
			const initFrame = result.frame;
			//await solveRecaptchaV2Enterprise(initFrame);
			const result2 = await findFrameWithSelectorRecursively(initFrame.childFrames(), 'input#recaptcha-token');
			const inputFrame = result2.frame;
			//console.log(await inputFrame.content());
			await userClick(inputFrame, '#recaptcha-anchor');
			await screenshot(`initial_captcha_click`);
			await page.waitForTimeout(3000);
			await solveComplexImageRecaptcha();
		} else {
			console.log('captcha not found');
		}
		await page.waitForTimeout(3000);
		//const cookies = await page.cookies();
		const cookies = (await client.send('Storage.getCookies')).cookies;
		console.log('[RESULT_JSON] ' + JSON.stringify({ agent:customUA, cookies, capturedResponse}));
		await screenshot('THE_END');
		await browser.close();
	} catch (err) {
		await browser.close();
		console.log('ERROR:', err.message);
		process.exit(1);
	}
})();
