require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());

const CUSTOMER_ID = process.env.NAVER_CUSTOMER_ID;
const ACCESS_LICENSE = process.env.NAVER_ACCESS_LICENSE;
const SECRET_KEY = process.env.NAVER_SECRET_KEY;

function generateSignature(timestamp, method, uri) {
    const message = `${timestamp}.${method}.${uri}`;
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    return hmac.update(message).digest('base64');
}

async function callNaverAPI(method, uri, params = null, data = null) {
    const timestamp = Date.now().toString();
    const signature = generateSignature(timestamp, method, uri);

    const config = {
        method: method,
        url: `https://api.naver.com${uri}`,
        headers: {
            'X-Timestamp': timestamp,
            'X-API-KEY': ACCESS_LICENSE,
            'X-Customer': CUSTOMER_ID,
            'X-Signature': signature,
            'Content-Type': 'application/json'
        },
        params: params,
        data: data
    };
    return await axios(config);
}

// 💡 파워컨텐츠 옵션 추가 및 클릭수(상한선) 중복 방지 로직 적용
async function getBidEstimate(keyword, device, bizType) {
    let networkType = bizType === 'powercontent' ? 'CONTENT' : 'WEBSITE';

    const requestData = {
        device: device,
        keywordPlus: true,
        key: keyword,
        bids: [70, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000, 7000, 10000, 15000, 20000, 30000]
    };

    // 파워컨텐츠일 경우 네트워크 타입 옵션 추가
    if (networkType === 'CONTENT') {
        requestData.netType = 'SEARCH';
        requestData.plcmtTp = 'CONTENT';
    }

    let result = { 
        1: { cpc: "-", cost: "-", clicks: "-" }, 
        2: { cpc: "-", cost: "-", clicks: "-" }, 
        3: { cpc: "-", cost: "-", clicks: "-" }, 
        4: { cpc: "-", cost: "-", clicks: "-" }, 
        5: { cpc: "-", cost: "-", clicks: "-" } 
    };

    try {
        const response = await callNaverAPI('POST', '/estimate/performance/keyword', null, requestData);
        const estimates = response.data.estimate;

        if (estimates && Array.isArray(estimates) && estimates.length > 0) {
            let validData = [];

            estimates.forEach(item => {
                if (item.clicks > 0 && item.cost > 0) {
                    const cpc = Math.round(item.cost / item.clicks);
                    validData.push({ cpc: cpc, cost: item.cost, clicks: item.clicks });
                }
            });

            // 1. 유입량(클릭수)이 높은 순으로 먼저 내림차순 정렬
            // 2. 만약 유입량이 완전히 똑같다면, 그중에서 가장 저렴한 CPC(비용)를 가진 것을 위로 올림
            validData.sort((a, b) => {
                if (b.clicks === a.clicks) {
                    return a.cpc - b.cpc;
                }
                return b.clicks - a.clicks;
            });

            let finalRanks = [];
            let seenClicks = new Set();

            // 💡 핵심: 클릭수가 완전히 똑같은 중복 데이터(가상의 고비용 1위들)는 무시하고, 
            // 클릭수가 달라지는 "진짜 유의미한 순위 변동 구간" 5개만 뽑아냅니다.
            for (let i = 0; i < validData.length; i++) {
                if (!seenClicks.has(validData[i].clicks)) {
                    seenClicks.add(validData[i].clicks);
                    finalRanks.push(validData[i]);
                }
                if (finalRanks.length >= 5) break;
            }

            // 추출된 5개 데이터를 1~5위에 매핑
            for (let i = 0; i < 5; i++) {
                if (finalRanks[i]) {
                    result[i + 1] = {
                        cpc: finalRanks[i].cpc.toLocaleString(),
                        cost: Math.round(finalRanks[i].cost).toLocaleString(),
                        clicks: Math.round(finalRanks[i].clicks).toLocaleString()
                    };
                }
            }
        }
        return result;

    } catch (error) {
        console.error(`[${device}] 에러:`, error.response ? error.response.data : error.message);
        return result;
    }
}

app.get('/api/get-naver-cpc', async (req, res) => {
    const keyword = req.query.keyword;
    const bizType = req.query.bizType || 'powerlink'; // 프론트에서 넘어온 탭 상태 파라미터 받기

    if (!keyword) return res.status(400).json({ success: false, message: '키워드를 입력해주세요.' });

    try {
        const statResponse = await callNaverAPI('GET', '/keywordstool', { hintKeywords: keyword, showDetail: 1 });
        const keywordDataList = statResponse.data.keywordList;

        if (!keywordDataList || keywordDataList.length === 0) {
            return res.json({ success: false, message: '조회된 데이터가 없습니다.' });
        }

        const targetData = keywordDataList[0];
        const formatNumber = (val) => typeof val === 'number' ? val.toLocaleString() : val;
        const getNum = (val) => typeof val === 'number' ? val : 0;

        // 가성비 키워드 3개 추출
        let goldenKeywords = keywordDataList
            .filter(k => k.relKeyword !== targetData.relKeyword && k.compIdx !== '높음')
            .sort((a, b) => (getNum(b.monthlyMobileQcCnt) + getNum(b.monthlyPcQcCnt)) - (getNum(a.monthlyMobileQcCnt) + getNum(a.monthlyPcQcCnt)))
            .slice(0, 5)
            .map(k => ({
                keyword: k.relKeyword,
                searchVol: formatNumber(getNum(k.monthlyMobileQcCnt) + getNum(k.monthlyPcQcCnt))
            }));

        if (goldenKeywords.length === 0) {
            goldenKeywords = keywordDataList.slice(1, 4).map(k => ({
                keyword: k.relKeyword,
                searchVol: formatNumber(getNum(k.monthlyMobileQcCnt) + getNum(k.monthlyPcQcCnt))
            }));
        }

        // 💡 단가 시뮬레이션 시 bizType을 함께 넘겨 파워링크/파워컨텐츠 분리 요청
        const pcBids = await getBidEstimate(targetData.relKeyword, 'PC', bizType);
        const mobileBids = await getBidEstimate(targetData.relKeyword, 'MOBILE', bizType);

        res.json({
            success: true,
            bizType: bizType,
            keyword: targetData.relKeyword,
            pcQcCnt: formatNumber(targetData.monthlyPcQcCnt),
            mobileQcCnt: formatNumber(targetData.monthlyMobileQcCnt),
            pcBids: pcBids,
            mobileBids: mobileBids,
            goldenKeywords: goldenKeywords
        });

    } catch (error) {
        console.error('API 에러:', error);
        res.status(500).json({ success: false, message: '서버 연동 중 오류가 발생했습니다.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});