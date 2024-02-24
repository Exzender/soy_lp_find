const path = require('path');
const fs = require('fs');
const { Web3 } = require('web3');
require('dotenv').config();

const ROUTER_ABI = require('./soy_finance_abi.json');
const LP_ABI = require('./lp_abi.json');
const RPC = 'https://rpc.callisto.network/';

const LP_ADDRESS = process.env.LP_ADDRESS || '0x1ceE27d0627ce8A81dF9B4D7eEE0d753b8c2F613'; // SOY-CLO LP
const FARM_ADDRESS = '0xf43Db9BeC8F8626Cb5ADD409C7EBc7272c8f5F8f';
const FARM2_ADDRESS = '0x0cf951123b2d337eb52091babe61afadfff330b4';
const ZERO_ADDRESS = '0X0000000000000000000000000000000000000000';
const LAST_BLOCK = BigInt(process.env.ENDBLOCK || '14186359');
const FIRST_BLOCK = BigInt(process.env.STARTBLOCK || '0');
const BATCH_SIZE = BigInt(10000);

const EVENT_TRANSFER = 'Transfer';

const holders = new Map();

function addToHolder(address, value) {
    let newVal = value;
    if (holders.has(address)) {
       newVal += holders.get(address);
    }
    holders.set(address, newVal);
}

// main ()
(async () => {
     // init Web3 provider
    const web3 = new Web3(RPC);
    const netId = await web3.eth.net.getId();
    console.log(`Connected to: ${netId}`);

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

    let outStr = 'address;LP wei;LP ether\n';
    for (const [key, value] of holders) {
        if (value > 0n) {
            outStr += `${key.toLowerCase()};${value};${web3.utils.fromWei(value, 'ether')}\n`;
        }
    }

    // console.dir(holders);
    fs.writeFileSync(path.resolve(__dirname + '/out', 'soy_holder.csv'), outStr, 'utf8');
})();