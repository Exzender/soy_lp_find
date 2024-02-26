const path = require('path');
const fs = require('fs');
const { Web3 } = require('web3');
const axios = require('axios');
require('dotenv').config();

const ROUTER_ABI = require('./soy_finance_abi.json');
const LP_ABI = require('./lp_abi.json');
const RPC = 'https://rpc.callisto.network/';

const ROUTER = '0xeb5b468faacc6bbdc14c4aacf0eec38abccc13e7'; // Soy Finance Router
const SOY_ADDRESS = '0x9FaE2529863bD691B4A7171bDfCf33C7ebB10a65';
const WCLO_ADDRESS = '0xF5AD6F6EDeC824C7fD54A66d241a227F6503aD3a';
const LP_ADDRESS = process.env.LP_ADDRESS || '0x1ceE27d0627ce8A81dF9B4D7eEE0d753b8c2F613'; // SOY-CLO LP
const FARM_ADDRESS = '0xf43Db9BeC8F8626Cb5ADD409C7EBc7272c8f5F8f';
const FARM2_ADDRESS = '0x0cf951123b2d337eb52091babe61afadfff330b4';
const ZERO_ADDRESS = '0X0000000000000000000000000000000000000000';
const LAST_BLOCK = BigInt(process.env.ENDBLOCK || '14186359');
const FIRST_BLOCK = BigInt(process.env.STARTBLOCK || '0');
const BATCH_SIZE = BigInt(10000);

const EVENT_TRANSFER = 'Transfer';
const EVENT_REMOVE = 'RemoveLiquidity';

const holders = new Map();

function addToHolder(address, value) {
    let newVal = value;
    if (holders.has(address)) {
       newVal += holders.get(address);
    }
    holders.set(address, newVal);
}

async function getTransaction(txHash) {
    try {
        const tx = (await axios(`https://explorer.callisto.network/api?module=transaction&action=gettxinfo&txhash=${txHash}`)).data;
        return tx;
    } catch (e) {
        console.log(`Error getting TX: ${txHash}`)
    }
}

function parseTx(tx, web3, idx) {
    let transfer;
    const tokenAddress = LP_ADDRESS.toLowerCase();
    const srcAddress = tx.result.from.replace(/^0x+/, '');

    for (let log of tx.result.logs) {
        if (log.address === tokenAddress) {
            if (log.topics[idx].indexOf(srcAddress) !== -1) {
                transfer = log;
                break;
            }
        }
    }

    const data = transfer['data'];
    const stripped = '0x' + data.replace(/^0x0+/, '');
    const val = BigInt(stripped);
    // return  web3.utils.fromWei(val, 'ether');
    return val;
}

async function findLPratio(web3) {
    const contract = new web3.eth.Contract(
        ROUTER_ABI,
        ROUTER
    );

    const testPair = [WCLO_ADDRESS.toUpperCase(), SOY_ADDRESS.toUpperCase()];

    const events = await contract.getPastEvents(EVENT_REMOVE, {
        fromBlock: LAST_BLOCK - BATCH_SIZE,
        toBlock: LAST_BLOCK
    });

    if (events.length) {
        const res = {
            clo: 0n,
            soy: 0n,
            lp: 0n
        }
        for (let i = events.length-1; i > 0; i--) {
            const event = events[i];
            const tokenA = event.returnValues['1'].toUpperCase();
            const tokenB = event.returnValues['2'].toUpperCase();

            if (testPair.includes(tokenB) && testPair.includes(tokenA)) {
                // console.dir(event);
                const tx = await getTransaction(event.transactionHash);
                if (tx) {
                    console.log(`RemoveLiquidity (SOY/CLO) at block ${event.blockNumber}: ${event.transactionHash}`);
                    res.soy = BigInt(event.returnValues['3']);
                    res.clo = BigInt(event.returnValues['4']);
                    res.lp =  parseTx(tx, web3, 1);
                    console.dir(res);
                    return res;
                }
            }
        }
    }
}

// main ()
(async () => {
     // init Web3 provider
    const web3 = new Web3(RPC);
    const netId = await web3.eth.net.getId();
    console.log(`Connected to: ${netId}`);

    const ratio = await findLPratio(web3);

    const fullBlocks = (LAST_BLOCK - FIRST_BLOCK);

    // lp contract
    const contract = new web3.eth.Contract(
        LP_ABI,
        LP_ADDRESS
    );

    const contracts = [ZERO_ADDRESS.toUpperCase(), FARM_ADDRESS.toUpperCase(), FARM2_ADDRESS.toUpperCase(), LP_ADDRESS.toUpperCase()];

    console.time('getEvents');
    let stopFlag = false;
    for (let i = FIRST_BLOCK; i < LAST_BLOCK; i += BATCH_SIZE) {
        const pcnt = Number(i - FIRST_BLOCK) / Number(fullBlocks) * 100;
        console.log(`block: ${i} -> ${pcnt}%`);
        console.time('getOneBatch');
        const lastBlock = (i + BATCH_SIZE - 1n) > LAST_BLOCK ? LAST_BLOCK : i + BATCH_SIZE - 1n;
        const events = await contract.getPastEvents(EVENT_TRANSFER, {
            fromBlock: i,
            toBlock: lastBlock
        });

        // parse transfer LP
        if (events.length) {
            for (let event of events) {
                const tokenA = event.returnValues['0'].toUpperCase();
                const tokenB = event.returnValues['1'].toUpperCase();
                const val = BigInt(event.returnValues['2']);

                if (tokenA === ZERO_ADDRESS && !contracts.includes(tokenB)) { // mint LP
                    addToHolder(tokenB, val);
                } else if (tokenB === LP_ADDRESS.toUpperCase() && !contracts.includes(tokenA))  {  // burn LP
                    addToHolder(tokenA, val * (-1n));
                } else if (!contracts.includes(tokenA) && !contracts.includes(tokenB)) {  // move to another holder
                    addToHolder(tokenA, val * (-1n));
                    addToHolder(tokenB, val);
                }
            }
        }
        console.timeEnd('getOneBatch');
    }

    console.timeEnd('getEvents');

    let outStr = 'address;LP wei;LP ether;CLO;SOY\n';
    const cloRatio = Number(web3.utils.fromWei(ratio.clo, 'ether')) / Number(web3.utils.fromWei(ratio.lp, 'ether'));
    const soyRatio = Number(web3.utils.fromWei(ratio.soy, 'ether')) / Number(web3.utils.fromWei(ratio.lp, 'ether'));
    for (const [key, value] of holders) {
        if (value > 0n) {
            const etherValue = Number(web3.utils.fromWei(value, 'ether'))
            const clo = cloRatio * etherValue;
            const soy = soyRatio * etherValue;
            outStr += `${key.toLowerCase()};${value};${etherValue};${clo};${soy}\n`;
        }
    }

    // console.dir(holders);
    fs.writeFileSync(path.resolve(__dirname + '/out', 'soy_holder_ratio.csv'), outStr, 'utf8');
})();